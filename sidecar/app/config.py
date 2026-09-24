"""Sidecar runtime configuration.

Every location and runtime choice comes from environment variables set by Rust
(docs/architecture.md, "Process model"); nothing here hardcodes a user path.
"""

from __future__ import annotations

import json
import os
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

# The sidecar source directory: repo `sidecar/` in dev, bundled resources when installed.
SIDECAR_DIR = Path(__file__).resolve().parents[1]
MODELS_JSON = SIDECAR_DIR / "models.json"
UPSTREAM_JSON = SIDECAR_DIR / "upstream.json"
# Data root for a sidecar started by hand during development (gitignored). The app always
# passes IRODORI_DATA_ROOT.
DEV_DATA_ROOT = SIDECAR_DIR / ".dev-data"

DEVICES = ("cuda", "mps", "cpu")
PRECISIONS = ("fp32", "bf16")


@dataclass(frozen=True)
class SidecarConfig:
    port: int
    device: str
    precision: str
    app_version: str
    data_root: Path | None
    log_dir: Path | None
    allowed_origins: tuple[str, ...]
    # HF_HOME (`<data-root>/models`): pinned model repos and the SilentCipher cache.
    models_dir: Path | None = None
    # Bundled LGPL ffmpeg (D20), when staged; used to decode uncommon upload formats.
    ffmpeg: Path | None = None

    @classmethod
    def from_env(cls, *, port: int, environ: Mapping[str, str] = os.environ) -> SidecarConfig:
        device = environ.get("IRODORI_DEVICE", "cpu")
        if device not in DEVICES:
            device = "cpu"
        precision = environ.get("IRODORI_PRECISION", "fp32")
        if precision not in PRECISIONS:
            precision = "fp32"
        origins = tuple(
            o.strip() for o in environ.get("IRODORI_ALLOWED_ORIGINS", "").split(",") if o.strip()
        )
        return cls(
            port=port,
            device=device,
            precision=precision,
            app_version=environ.get("IRODORI_APP_VERSION", "0.0.0"),
            data_root=_optional_path(environ.get("IRODORI_DATA_ROOT")),
            log_dir=_optional_path(environ.get("IRODORI_LOG_DIR")),
            allowed_origins=origins,
            models_dir=_optional_path(environ.get("HF_HOME")),
            ffmpeg=_optional_path(environ.get("IRODORI_FFMPEG")),
        )

    @property
    def root(self) -> Path:
        return self.data_root or DEV_DATA_ROOT

    @property
    def models_root(self) -> Path:
        return self.models_dir or self.root / "models"


def upstream_commit() -> str | None:
    """The pinned upstream commit recorded next to the sidecar source."""
    try:
        return str(json.loads(UPSTREAM_JSON.read_text(encoding="utf-8"))["commit"])
    except (OSError, ValueError, KeyError):
        return None


def _optional_path(value: str | None) -> Path | None:
    return Path(value) if value else None
