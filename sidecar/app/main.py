"""Sidecar entry point: `python -m app.main --port <port>` (spawned by Rust, D1/D10).

Serves the internal API on 127.0.0.1 only, on the port Rust picked. Configuration
comes from the environment Rust sets (app/config.py). The process exits when the app
that started it is gone, so it never outlives the app (golden rule 4).
"""

from __future__ import annotations

import argparse

import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import SidecarConfig
from app.errors import register_error_handlers
from app.lifecycle import exit_with_parent, force_utf8
from app.routers import system


def create_app(config: SidecarConfig) -> FastAPI:
    app = FastAPI(title="irodori-studio sidecar", version=config.app_version)
    app.state.config = config
    # The WebView calls this API cross-origin; only the app's own origins may read it.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(config.allowed_origins),
        allow_methods=["*"],
        allow_headers=["*"],
    )
    register_error_handlers(app)
    app.include_router(system.router)
    return app


def main(argv: list[str] | None = None) -> None:
    force_utf8()
    parser = argparse.ArgumentParser(prog="python -m app.main")
    parser.add_argument("--port", type=int, required=True)
    args = parser.parse_args(argv)

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
