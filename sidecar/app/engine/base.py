"""`TtsBackend` protocol (D6) and the engine-level data types it exchanges.

Routers and services talk to a backend only through this protocol; v1 ships
`TorchBackend` (`engine/irodori_adapter.py`, devices cuda / mps / cpu). `MlxBackend` is a
reserved name only. Nothing here imports torch, so services stay testable without it.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol

import numpy as np

from app.engine.registry import ModelSpec


@dataclass(frozen=True)
class RuntimeOptions:
    """Settings that require a model reload (D4)."""

    device: str  # "cuda" | "mps" | "cpu"
    model_precision: str = "fp32"  # "fp32" | "bf16" (bf16 on CUDA only)
    codec_device: str = "cpu"
    codec_precision: str = "fp32"
    compile_model: bool = False
    compile_dynamic: bool = False


@dataclass(frozen=True)
class BackendRequest:
    """One synthesis call with every input resolved to local files and final values."""

    text: str
    caption: str | None
    # Exactly one speaker source: cached reference latents, an embedding, or neither.
    ref_latents: tuple[Path, ...] = ()
    ref_embed: Path | None = None
    lora_adapter: Path | None = None
    # Resolved parameters from `engine/params.py` (upstream field names), without `seed`.
    params: dict[str, object] = field(default_factory=dict)
    seed: int = 0
    watermark: bool = True


@dataclass
class BackendHooks:
    """Callbacks from inside a running synthesis (D27)."""

    on_log: Callable[[str], None] = lambda _line: None
    # (steps done, total steps) of the sampling loop.
    on_progress: Callable[[int, int], None] = lambda _done, _total: None
    # Polled at every sampling step; returning True aborts with `SynthesisCancelled`.
    is_cancelled: Callable[[], bool] = lambda: False


@dataclass(frozen=True)
class BackendResult:
    audios: list[np.ndarray]  # float32 mono waveforms, one per candidate
    sample_rate: int
    used_seed: int
    timings: dict[str, float]  # milliseconds per stage, in execution order
    messages: list[str]
    watermarked: bool


class SynthesisCancelled(Exception):  # noqa: N818 - a control-flow signal, not an error
    """Raised inside a backend when `BackendHooks.is_cancelled` turns true."""


class BackendError(Exception):
    """A failure with a stable error code (`app/errors.py::ErrorCode` value)."""

    def __init__(self, code: str, message: str, detail: dict[str, object] | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.detail = detail or {}


class TtsBackend(Protocol):
    name: str

    def required_files(self, spec: ModelSpec, models_root: Path) -> dict[str, Path]:
        """Local files the model needs; all must exist before `load`."""
        ...

    def load(self, spec: ModelSpec, options: RuntimeOptions, models_root: Path) -> None: ...

    def unload(self) -> None: ...

    @property
    def watermark_ready(self) -> bool:
        """Whether the watermarker loaded (D12 must never lapse silently)."""
        ...

    @property
    def speaker_dim(self) -> int | None:
        """Width of a speaker embedding token, to validate Speaker Inversion files."""
        ...

    def device_info(self) -> dict[str, object]: ...

    def encode_reference(
        self,
        clip: Path,
        dest: Path,
        *,
        normalize_db: float | None,
        ensure_max: bool,
        max_seconds: float,
    ) -> None:
        """Encode one reference clip into a latent file usable as `ref_latents`."""
        ...

    def synthesize(self, request: BackendRequest, hooks: BackendHooks) -> BackendResult: ...


BackendFactory = Callable[[], TtsBackend]
