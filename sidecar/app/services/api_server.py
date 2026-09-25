"""The external API listener (D21): a second uvicorn server inside the sidecar, started,
stopped and reconfigured from the API Server screen.

The port is bound here first, so a port in use becomes a status (`api_port_in_use`)
instead of uvicorn exiting the whole sidecar. The configuration is kept in the
preferences table; the last requests are kept in memory for the request log.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import socket
from collections import deque
from collections.abc import Callable, Iterator

import uvicorn
from fastapi import FastAPI

from app.errors import ErrorCode
from app.schemas import ApiRequestLog, ApiServerConfig, ApiServerStatus
from app.storage.db import Database

log = logging.getLogger("irodori.api_server")

KEY = "api_server"
LOG_SIZE = 200
STOP_TIMEOUT_S = 10.0
START_TIMEOUT_S = 10.0


class ApiServerStore:
    """The listener's configuration, under its own key in the preferences table."""

    def __init__(self, db: Database) -> None:
        self._db = db

    def get(self) -> ApiServerConfig:
        row = self._db.query_one("SELECT value FROM preferences WHERE key = ?", (KEY,))
        if row is None:
            return ApiServerConfig()
        try:
            return ApiServerConfig(**json.loads(row["value"]))
        except (ValueError, TypeError):
            return ApiServerConfig()

    def save(self, config: ApiServerConfig) -> None:
        with self._db.transaction() as conn:
            conn.execute(
                "INSERT INTO preferences (key, value) VALUES (?, ?) "
                "ON CONFLICT (key) DO UPDATE SET value = excluded.value",
                (KEY, json.dumps(config.model_dump())),
            )


class _QuietServer(uvicorn.Server):
    """A second server must not take over the process's signal handlers."""

    @contextlib.contextmanager
    def capture_signals(self) -> Iterator[None]:
        yield


class ApiServerManager:
    def __init__(self, store: ApiServerStore, app_factory: Callable[[ApiServerManager], FastAPI]):
        self._store = store
        self._factory = app_factory
        self._config = store.get()
        self._server: uvicorn.Server | None = None
        self._task: asyncio.Task[None] | None = None
        self._error: str | None = None
        self._log: deque[ApiRequestLog] = deque(maxlen=LOG_SIZE)
        self._lock = asyncio.Lock()

    @property
    def config(self) -> ApiServerConfig:
        return self._config

    def api_key(self) -> str | None:
        """Read on every request, so a new key applies at once."""
        return self._config.api_key

    def record(self, entry: ApiRequestLog) -> None:
        self._log.append(entry)

    async def configure(self, config: ApiServerConfig) -> ApiServerStatus:
        self._store.save(config)
        self._config = config
        await self.apply()
        return self.status()

    async def apply(self) -> None:
        """(Re)start the listener as configured, or stop it."""
        async with self._lock:
            await self._stop()
            self._error = None
            config = self._config
            if not config.enabled:
                return
            if config.bind == "lan" and not config.api_key:
                self._error = ErrorCode.API_KEY_REQUIRED.value
                return
            host = "0.0.0.0" if config.bind == "lan" else "127.0.0.1"
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            try:
                sock.bind((host, config.port))
            except OSError as exc:
                sock.close()
                log.warning("api server: cannot bind %s:%d: %s", host, config.port, exc)
                self._error = ErrorCode.API_PORT_IN_USE.value
                return
            server = _QuietServer(
                uvicorn.Config(
                    self._factory(self), log_level="warning", access_log=False, lifespan="off"
                )
            )
            self._server = server
            self._task = asyncio.create_task(server.serve(sockets=[sock]))
            deadline = asyncio.get_running_loop().time() + START_TIMEOUT_S
            while not server.started and not self._task.done():
                if asyncio.get_running_loop().time() > deadline:
                    break
                await asyncio.sleep(0.02)
            if not server.started:
                log.warning("api server did not start")
                self._error = ErrorCode.INTERNAL_ERROR.value
                await self._stop()
                return
            log.info("api server listening on %s:%d", host, config.port)

    async def stop(self) -> None:
        async with self._lock:
            await self._stop()

    async def _stop(self) -> None:
        server, task = self._server, self._task
        self._server = self._task = None
        if server is None or task is None:
            return
        server.should_exit = True
        try:
            await asyncio.wait_for(task, STOP_TIMEOUT_S)
        except (asyncio.TimeoutError, Exception):  # noqa: BLE001 — shutting down anyway
            server.force_exit = True
            task.cancel()
        log.info("api server stopped")

    def status(self) -> ApiServerStatus:
        running = (
            self._server is not None
            and self._server.started
            and self._task is not None
            and not self._task.done()
        )
        port = self._config.port
        urls = [f"http://127.0.0.1:{port}"] if running else []
        if running and self._config.bind == "lan":
            urls += [f"http://{address}:{port}" for address in lan_addresses()]
        return ApiServerStatus(
            running=running,
            error=self._error,
            urls=urls,
            requests=list(reversed(self._log)),
        )


def lan_addresses() -> list[str]:
    """This computer's IPv4 addresses other devices may reach."""
    try:
        infos = socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET)
    except OSError:
        return []
    addresses = sorted({str(info[4][0]) for info in infos})
    return [a for a in addresses if not a.startswith("127.") and not a.startswith("169.254.")]
