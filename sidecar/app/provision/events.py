"""Machine-readable progress lines for the Rust bootstrap.

A line `IRODORI_EVENT {"event": ..., ...}` on stdout is parsed by Rust; any other
output is treated as a plain log line.
"""

from __future__ import annotations

import json

EVENT_PREFIX = "IRODORI_EVENT "


def emit(event: str, **data: object) -> None:
    print(EVENT_PREFIX + json.dumps({"event": event, **data}, ensure_ascii=False), flush=True)


def describe(exc: BaseException, limit: int = 500) -> str:
    """Short technical description for logs (not UI copy)."""
    text = f"{type(exc).__name__}: {exc}"
    return text if len(text) <= limit else text[: limit - 1] + "…"
