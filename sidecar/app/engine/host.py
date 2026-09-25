"""Resident `EngineHost`: one loaded model shared by the UI and the external API (D4, D24).

The model loads once, in the background, right after the sidecar starts (setup has
finished by then); `GET /health` reports the engine state so the app can show
`loading_model` until it is ready. Every synthesis runs on the queue's worker thread.
"""

from __future__ import annotations

import logging
import threading
import time
from pathlib import Path
from typing import Literal

from app.config import SidecarConfig
from app.engine.base import BackendError, BackendFactory, RuntimeOptions, TtsBackend
from app.engine.registry import ModelSpec, Registry
from app.errors import ErrorCode
from app.schemas import EngineStatus, RuntimeInfo

log = logging.getLogger("irodori.engine")

EngineState = Literal["idle", "loading", "ready", "error"]


def runtime_options(config: SidecarConfig) -> RuntimeOptions:
    """Device plan from setup (D7–D9) -> upstream runtime options.

    The codec follows the model's device (D8 allows a per-component fallback later) and
    stays fp32: it is small, and the audio path is where precision is audible.
    """
    precision = config.precision if config.device == "cuda" else "fp32"
    return RuntimeOptions(
        device=config.device,
        model_precision=precision,
        codec_device=config.device,
        codec_precision="fp32",
    )


class EngineHost:
    def __init__(
        self,
        registry: Registry,
        options: RuntimeOptions,
        models_root: Path,
        backend_factory: BackendFactory,
    ) -> None:
        self.registry = registry
        self.spec: ModelSpec = registry.default
        self.options = options
        self.models_root = models_root
        self._factory = backend_factory
        self._cond = threading.Condition()
        self._state: EngineState = "idle"
        self._error_code: str | None = None
        self._backend: TtsBackend | None = None
        self._probe = backend_factory()  # unloaded instance, for file checks only

    # --- State ------------------------------------------------------------------------

    @property
    def state(self) -> EngineState:
        return self._state

    def status(self) -> EngineStatus:
        options = self.options
        with self._cond:
            return EngineStatus(
                state=self._state,
                model_id=self.spec.id,
                error_code=self._error_code,
                runtime=RuntimeInfo(
                    device=options.device,  # type: ignore[arg-type]
                    model_precision=options.model_precision,  # type: ignore[arg-type]
                    codec_device=options.codec_device,  # type: ignore[arg-type]
                    codec_precision=options.codec_precision,  # type: ignore[arg-type]
                    compile_model=options.compile_model,
                    compile_dynamic=options.compile_dynamic,
                ),
            )

    def wait_settled(self, timeout: float) -> bool:
        """True once the model is ready or failed to load (never while idle/loading)."""
        with self._cond:
            return self._cond.wait_for(lambda: self._state in ("ready", "error"), timeout)

    def backend(self) -> TtsBackend:
        with self._cond:
            if self._state == "ready" and self._backend is not None:
                return self._backend
            code = self._error_code or ErrorCode.MODEL_NOT_LOADED.value
        raise BackendError(code, "the model is not loaded")

    @property
    def speaker_dim(self) -> int | None:
        with self._cond:
            backend = self._backend if self._state == "ready" else None
        return None if backend is None else backend.speaker_dim

    @property
    def watermark_ready(self) -> bool | None:
        with self._cond:
            backend = self._backend if self._state == "ready" else None
        return None if backend is None else backend.watermark_ready

    def installed(self, spec: ModelSpec) -> bool:
        files = self._probe.required_files(spec, self.models_root)
        return all(path.is_file() for path in files.values())

    # --- Loading ----------------------------------------------------------------------

    def start(self) -> None:
        with self._cond:
            if self._state in ("loading", "ready"):
                return
            self._state = "loading"
            self._error_code = None
        threading.Thread(target=self._load, name="model-load", daemon=True).start()

    def _load(self) -> None:
        started = time.perf_counter()
        log.info(
            "loading %s on %s (%s)", self.spec.id, self.options.device, self.options.model_precision
        )
        backend = self._factory()
        error_code: str | None = None
        try:
            backend.load(self.spec, self.options, self.models_root)
        except BackendError as exc:
            error_code = exc.code
            log.error("model load failed: %s %s %s", exc.code, exc.message, exc.detail)
        except Exception:
            error_code = ErrorCode.MODEL_LOAD_FAILED.value
            log.exception("model load failed")
        with self._cond:
            if error_code is None:
                self._backend = backend
                self._state = "ready"
            else:
                self._state = "error"
                self._error_code = error_code
            self._cond.notify_all()
        if error_code is None:
            log.info(
                "model ready in %.1f s (watermark ready: %s)",
                time.perf_counter() - started,
                backend.watermark_ready,
            )

    def mark_broken(self, code: str) -> None:
        """The device failed mid-generation: refuse further work with `code` until the
        sidecar restarts (the app offers the restart)."""
        with self._cond:
            if self._state != "ready":
                return
            self._state = "error"
            self._error_code = code
            self._cond.notify_all()
        log.error("engine unusable after a device failure: %s", code)

    def shutdown(self) -> None:
        with self._cond:
            backend, self._backend = self._backend, None
            self._state = "idle"
        if backend is not None:
            backend.unload()
