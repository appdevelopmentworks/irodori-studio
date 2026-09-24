"""Sidecar entry point: `python -m app.main --port <port>` (spawned by Rust, D1/D10).

Serves the internal API on 127.0.0.1 only, on the port Rust picked. Configuration
comes from the environment Rust sets (app/config.py). The process exits when the app
that started it is gone, so it never outlives the app (golden rule 4). The model starts
loading as soon as the server is up (D4).
"""

from __future__ import annotations

import argparse
import logging
import sys
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import SidecarConfig
from app.engine.base import BackendFactory
from app.errors import register_error_handlers
from app.lifecycle import exit_with_parent, force_utf8
from app.routers import (
    audio,
    clips,
    history,
    jobs,
    models,
    narration,
    preferences,
    system,
    text,
    tts,
    voices,
)
from app.services.container import build_services


def create_app(
    config: SidecarConfig,
    *,
    backend_factory: BackendFactory | None = None,
    autoload: bool = True,
) -> FastAPI:
    services = build_services(config, backend_factory=backend_factory, autoload=autoload)

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        services.start()
        try:
            yield
        finally:
            services.stop()

    app = FastAPI(title="irodori-studio sidecar", version=config.app_version, lifespan=lifespan)
    app.state.config = config
    app.state.services = services
    # The WebView calls this API cross-origin; only the app's own origins may read it.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(config.allowed_origins),
        allow_methods=["*"],
        allow_headers=["*"],
    )
    register_error_handlers(app)
    for module in (
        system,
        models,
        tts,
        jobs,
        audio,
        clips,
        voices,
        text,
        narration,
        history,
        preferences,
    ):
        app.include_router(module.router)
    return app


def main(argv: list[str] | None = None) -> None:
    force_utf8()
    parser = argparse.ArgumentParser(prog="python -m app.main")
    parser.add_argument("--port", type=int, required=True)
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        stream=sys.stdout,
    )
    exit_with_parent()
    config = SidecarConfig.from_env(port=args.port)
    uvicorn.run(
        create_app(config),
        host="127.0.0.1",
        port=config.port,
        log_level="info",
        access_log=False,
    )


if __name__ == "__main__":
    main()
