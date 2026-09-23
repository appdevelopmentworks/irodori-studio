"""Sidecar entry point: `python -m app.main --port <port> --data-root <dir>`.

Starts the internal uvicorn listener on 127.0.0.1 (port chosen by Rust, D10) and the
optional external API listener (D21). Implemented in Session 1.
"""
