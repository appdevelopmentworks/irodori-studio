"""Shared fixtures: a torch-free fake backend and API clients wired to it."""

from __future__ import annotations

import json
import threading
import time
from collections.abc import Callable, Iterator
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.config import SidecarConfig
from app.engine.base import (
    BackendError,
    BackendHooks,
    BackendRequest,
    BackendResult,
    RuntimeOptions,
    SynthesisCancelled,
)
from app.engine.registry import ModelSpec
from app.main import create_app

TERMINAL = {"completed", "failed", "cancelled"}


class FakeBackend:
    """Deterministic stand-in for TorchBackend: audio is noise seeded by the request."""

    name = "fake"

    def __init__(
        self,
        *,
        fail_load: str | None = None,
        watermark_ready: bool = True,
        hold_load: bool = False,
    ) -> None:
        self.fail_load = fail_load
        self._watermark_ready = watermark_ready
        self.loaded = False
        self.requests: list[BackendRequest] = []
        self.encoded: list[Path] = []
        # Set `blocking` to make synthesize wait for `release` (cancel tests).
        self.blocking = False
        self.release = threading.Event()
        self.started = threading.Event()
        self.load_gate = threading.Event()
        if not hold_load:
            self.load_gate.set()

    def required_files(self, spec: ModelSpec, models_root: Path) -> dict[str, Path]:
        return {}

    def load(self, spec: ModelSpec, options: RuntimeOptions, models_root: Path) -> None:
        self.load_gate.wait(10)
        if self.fail_load:
            raise BackendError(self.fail_load, "fake load failure")
        self.loaded = True

    def unload(self) -> None:
        self.loaded = False

    @property
    def watermark_ready(self) -> bool:
        return self._watermark_ready

    @property
    def speaker_dim(self) -> int:
        return 768

    def device_info(self) -> dict[str, object]:
        return {"device": "cpu"}

    def encode_reference(
        self,
        clip: Path,
        dest: Path,
        *,
        normalize_db: float | None,
        ensure_max: bool,
        max_seconds: float,
    ) -> None:
        self.encoded.append(clip)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(b"latent")

    def synthesize(self, request: BackendRequest, hooks: BackendHooks) -> BackendResult:
        self.requests.append(request)
        self.started.set()
        while self.blocking and not self.release.is_set():
            if hooks.is_cancelled():
                raise SynthesisCancelled()
            time.sleep(0.01)
        total = int(request.params["num_steps"])  # type: ignore[arg-type]
        for step in range(total):
            if hooks.is_cancelled():
                raise SynthesisCancelled()
            hooks.on_progress(step, total)
        hooks.on_progress(total, total)
        hooks.on_log("fake: synthesized")
        rng = np.random.default_rng(request.seed)
        count = int(request.params["num_candidates"])  # type: ignore[arg-type]
        audios = [rng.uniform(-0.5, 0.5, 4800).astype(np.float32) for _ in range(count)]
        timings = {"sample_rf": 1.0}
        watermarked = request.watermark and self._watermark_ready
        if watermarked:
            timings["silentcipher_watermark"] = 0.5
        return BackendResult(
            audios=audios,
            sample_rate=48000,
            used_seed=request.seed,
            timings=timings,
            messages=[],
            watermarked=watermarked,
        )


ClientFactory = Callable[..., tuple[TestClient, FakeBackend]]


@pytest.fixture
def make_client(tmp_path: Path) -> Iterator[ClientFactory]:
    """`make_client(backend=None, **env)` -> a started app (lifespan on) + its backend."""
    clients: list[TestClient] = []

    def factory(backend: FakeBackend | None = None, **env: str) -> tuple[TestClient, FakeBackend]:
        backend = backend or FakeBackend()
        environ = {
            "IRODORI_DEVICE": "cpu",
            "IRODORI_DATA_ROOT": str(tmp_path / "data"),
            **env,
        }
        app = create_app(
            SidecarConfig.from_env(port=0, environ=environ),
            backend_factory=lambda: backend,
        )
        client = TestClient(app)
        client.__enter__()
        clients.append(client)
        return client, backend

    yield factory
    for client in clients:
        client.__exit__(None, None, None)


def wait_ready(client: TestClient, timeout: float = 10.0) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        engine = client.get("/health").json()["engine"]
        if engine["state"] in ("ready", "error"):
            return engine
        time.sleep(0.02)
    raise AssertionError("engine did not settle")


def read_events(client: TestClient, job_id: str, **headers: str) -> list[tuple[str, dict]]:
    """Collect a job's SSE stream until its terminal event."""
    events: list[tuple[str, dict]] = []
    with client.stream("GET", f"/jobs/{job_id}/events", headers=headers) as response:
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/event-stream")
        kind: str | None = None
        data: dict = {}
        for line in response.iter_lines():
            if line.startswith("event:"):
                kind = line.partition(":")[2].strip()
            elif line.startswith("data:"):
                data = json.loads(line.partition(":")[2].strip())
            elif line == "" and kind is not None:
                events.append((kind, data))
                if kind in TERMINAL:
                    break
                kind, data = None, {}
    return events


def generate(client: TestClient, **body: object) -> str:
    response = client.post("/tts/generate", json={"text": "こんにちは。", **body})
    assert response.status_code == 202, response.text
    return response.json()["job_id"]
