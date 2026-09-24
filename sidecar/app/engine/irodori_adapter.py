"""`TorchBackend`: maps our requests onto upstream `InferenceRuntime` / `SamplingRequest`.

This is the ONLY module allowed to import `irodori_tts` (D3; enforced by
tests/test_dependency_policy.py). Never edit third_party/Irodori-TTS. torch and
`irodori_tts` are imported lazily: the dev venv has no torch (D2), and importing the
package imports torch.

Integration points with the pinned upstream (decisions.md, S2):
- Model files are passed as local paths (checkpoint + sibling `tokenizer/`, codec
  `weights.pth`), so loading never touches the network.
- Watermark OFF (D12): upstream applies SilentCipher whenever `runtime.watermarker.ready`;
  for a request with the watermark disabled the runtime's watermarker attribute is swapped
  for a disabled stand-in for the duration of that call.
- Progress and cancellation (D27): upstream has no hooks, so a wrapper around the model's
  `forward_with_encoded_conditions` instance attribute (the attribute upstream itself
  replaces for torch.compile) observes every sampling step, reports progress and raises
  `SynthesisCancelled` when asked to stop.
"""

from __future__ import annotations

import ast
import gc
import importlib.util
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, fields
from pathlib import Path
from typing import Any

import numpy as np

from app.assets import pinned_file
from app.engine import params as param_table
from app.engine.base import (
    BackendError,
    BackendHooks,
    BackendRequest,
    BackendResult,
    RuntimeOptions,
    SynthesisCancelled,
)
from app.engine.registry import ModelSpec

# Upstream file layout: `download_hf_checkpoint` fetches `model.safetensors` (+ `tokenizer/`)
# and `DACVAECodec.load` fetches `weights.pth`.
CHECKPOINT_FILE = "model.safetensors"
CODEC_FILE = "weights.pth"

_WATERMARK_MISSING_PREFIX = "warning: SilentCipher watermark is unavailable"


def check_upstream() -> dict[str, object]:
    """Import the upstream runtime once, proving the provisioned venv is complete.

    Used by first-run setup (app/provision/selfcheck.py). Reports instead of raising:
    the caller turns a failure into an error code.
    """
    try:
        import irodori_tts.inference_runtime  # noqa: F401
    except Exception as exc:
        return {"importable": False, "error": f"{type(exc).__name__}: {exc}"}
    return {"importable": True, "error": None}


@dataclass(frozen=True)
class EmojiEntry:
    symbol: str
    label: str
    description: str


def emoji_palette() -> list[EmojiEntry]:
    """Upstream's emoji palette (`EMOJI_PALETTE_ITEMS`), read from source.

    The defining module imports gradio, which the sidecar does not install (decisions.md,
    S0), so the constant is parsed with `ast` instead of imported.
    """
    spec = importlib.util.find_spec("irodori_tts")
    if spec is None or not spec.submodule_search_locations:
        raise BackendError("upstream_unavailable", "irodori_tts is not on the path")
    source = Path(next(iter(spec.submodule_search_locations))) / "gradio_emoji_palette.py"
    tree = ast.parse(source.read_text(encoding="utf-8"))
    for node in tree.body:
        target = getattr(node, "target", None) or next(iter(getattr(node, "targets", [])), None)
        if isinstance(target, ast.Name) and target.id == "EMOJI_PALETTE_ITEMS":
            value = getattr(node, "value", None)
            if not isinstance(value, ast.Tuple):
                break
            items: list[EmojiEntry] = []
            for call in value.elts:
                if not isinstance(call, ast.Call) or len(call.args) != 3:
                    raise BackendError("upstream_unavailable", "unexpected palette entry")
                symbol, label, description = (ast.literal_eval(arg) for arg in call.args)
                items.append(EmojiEntry(str(symbol), str(label), str(description)))
            return items
    raise BackendError("upstream_unavailable", "EMOJI_PALETTE_ITEMS not found")


class _NoWatermark:
    """Stand-in for `SilentCipherWatermarker` when the policy turns the watermark off."""

    ready = False

    def encode_batch(self, audios: list[Any], *, sample_rate: int) -> list[Any]:
        return audios


class _Observation:
    def __init__(self, total: int, hooks: BackendHooks) -> None:
        self.total = total
        self.hooks = hooks
        self.steps_started = 0
        self.last_t: float | None = None


class _StepMonitor:
    """Sampling-step progress and cooperative cancellation (D27).

    Upstream's samplers call `model.forward_with_encoded_conditions(..., t=...)` one or
    more times per step (CFG modes differ), always through the instance attribute. Every
    step has its own strictly decreasing `t`, so a new value marks a new step.
    """

    def __init__(self) -> None:
        self._active: _Observation | None = None

    def install(self, model: Any) -> None:
        inner = model.forward_with_encoded_conditions
        monitor = self

        def forward_with_encoded_conditions(*args: Any, **kwargs: Any) -> Any:
            t = kwargs["t"] if "t" in kwargs else (args[1] if len(args) > 1 else None)
            monitor.on_forward(t)
            return inner(*args, **kwargs)

        model.forward_with_encoded_conditions = forward_with_encoded_conditions

    @contextmanager
    def observe(self, total: int, hooks: BackendHooks) -> Iterator[_Observation]:
        observation = _Observation(total, hooks)
        self._active = observation
        try:
            yield observation
        finally:
            self._active = None

    def on_forward(self, t: Any) -> None:
        observation = self._active
        if observation is None or t is None:
            return
        value = float(t.reshape(-1)[0]) if hasattr(t, "reshape") else float(t)
        if value == observation.last_t:
            return
        observation.last_t = value
        if observation.hooks.is_cancelled():
            raise SynthesisCancelled()
        observation.hooks.on_progress(observation.steps_started, observation.total)
        observation.steps_started += 1


class TorchBackend:
    """Upstream `InferenceRuntime` on cuda / mps / cpu, owned by `EngineHost` (D4)."""

    name = "torch"

    def __init__(self) -> None:
        self._runtime: Any = None
        self._spec: ModelSpec | None = None
        self._options: RuntimeOptions | None = None
        self._monitor = _StepMonitor()
        self._lock = threading.Lock()

    # --- Lifecycle --------------------------------------------------------------------

    def required_files(self, spec: ModelSpec, models_root: Path) -> dict[str, Path]:
        return {
            "checkpoint": pinned_file(models_root, spec.hf_repo, spec.hf_revision, CHECKPOINT_FILE),
            "tokenizer": pinned_file(
                models_root, spec.hf_repo, spec.hf_revision, "tokenizer/tokenizer_config.json"
            ),
            "codec": pinned_file(models_root, spec.codec_repo, spec.codec_revision, CODEC_FILE),
        }

    def load(self, spec: ModelSpec, options: RuntimeOptions, models_root: Path) -> None:
        files = self.required_files(spec, models_root)
        missing = [str(path) for path in files.values() if not path.is_file()]
        if missing:
            raise BackendError(
                "model_files_missing", "model files are missing", {"missing": missing}
            )
        from irodori_tts.inference_runtime import InferenceRuntime, RuntimeKey, SamplingRequest

        unknown = param_table.NAMES - {f.name for f in fields(SamplingRequest)}
        if unknown:
            # The parameter table drifted from the pinned upstream (engine/params.py).
            raise BackendError(
                "upstream_incompatible",
                "parameter table does not match upstream SamplingRequest",
                {"unknown": sorted(unknown)},
            )
        key = RuntimeKey(
            checkpoint=str(files["checkpoint"]),
            model_device=options.device,
            codec_repo=str(files["codec"]),
            model_precision=options.model_precision,
            codec_device=options.codec_device,
            codec_precision=options.codec_precision,
            compile_model=options.compile_model,
            compile_dynamic=options.compile_dynamic,
        )
        # Not `get_cached_runtime`: residency is owned by EngineHost (D4).
        runtime = InferenceRuntime.from_key(key)
        self._monitor.install(runtime.model)
        with self._lock:
            self._runtime = runtime
            self._spec = spec
            self._options = options

    def unload(self) -> None:
        with self._lock:
            runtime, self._runtime = self._runtime, None
        if runtime is not None:
            runtime.unload()
        gc.collect()

    @property
    def watermark_ready(self) -> bool:
        runtime = self._runtime
        return bool(runtime is not None and runtime.watermarker.ready)

    def device_info(self) -> dict[str, object]:
        options = self._options
        if options is None:
            return {}
        return {
            "device": options.device,
            "model_precision": options.model_precision,
            "codec_device": options.codec_device,
            "codec_precision": options.codec_precision,
        }

    # --- Inference --------------------------------------------------------------------

    def encode_reference(
        self,
        clip: Path,
        dest: Path,
        *,
        normalize_db: float | None,
        ensure_max: bool,
        max_seconds: float,
    ) -> None:
        """Encode one clip exactly like upstream's waveform path, cached as a latent file.

        Mirrors `InferenceRuntime._load_reference_latent`: soundfile decode (upstream's
        fallback, used here because FFmpeg-backed torchaudio decoding is unavailable),
        the single-clip trim to `max_seconds`, then `codec.encode_waveform`.
        """
        import soundfile as sf
        import torch

        runtime = self._require_runtime()
        data, sample_rate = sf.read(str(clip), dtype="float32", always_2d=True)
        wav = torch.from_numpy(np.ascontiguousarray(data.T))  # (channels, samples)
        if max_seconds > 0:
            wav = wav[:, : max(1, int(max_seconds * float(sample_rate)))]
        latent = runtime.codec.encode_waveform(
            wav.unsqueeze(0),
            sample_rate=int(sample_rate),
            normalize_db=normalize_db,
            ensure_max=bool(ensure_max),
        ).cpu()
        if latent.shape[1] == 0:
            raise BackendError("clip_too_short", "reference clip produced an empty latent")
        dest.parent.mkdir(parents=True, exist_ok=True)
        partial = dest.with_name(dest.name + ".part")
        torch.save(latent, partial)
        partial.replace(dest)

    def synthesize(self, request: BackendRequest, hooks: BackendHooks) -> BackendResult:
        import torch
        from irodori_tts.inference_runtime import SamplingRequest

        runtime = self._require_runtime()
        spec = self._spec
        assert spec is not None
        values = dict(request.params)
        values.pop("seed", None)
        num_steps = int(values["num_steps"])  # always resolved by engine/params.py
        sampling = SamplingRequest(
            text=request.text,
            caption=request.caption,
            ref_latents=[str(path) for path in request.ref_latents] or None,
            ref_embed=None if request.ref_embed is None else str(request.ref_embed),
            no_ref=not request.ref_latents and request.ref_embed is None,
            lora_adapter=None if request.lora_adapter is None else str(request.lora_adapter),
            max_seconds=float(spec.capabilities.max_output_seconds),
            seed=int(request.seed),
            **values,
        )

        def log(line: str) -> None:
            if not request.watermark and line.startswith(_WATERMARK_MISSING_PREFIX):
                return  # expected: the policy turned the watermark off
            hooks.on_log(line)

        original_watermarker = runtime.watermarker
        watermarked = bool(request.watermark and original_watermarker.ready)
        if not request.watermark:
            runtime.watermarker = _NoWatermark()
            hooks.on_log("[adapter] watermark disabled by policy")
        started = time.perf_counter()
        try:
            with self._monitor.observe(num_steps, hooks):
                result = runtime.synthesize(sampling, log_fn=log)
        except SynthesisCancelled:
            raise
        except ValueError as exc:
            raise BackendError("invalid_params", str(exc), {"reason": "upstream"}) from exc
        except RuntimeError as exc:  # includes torch.OutOfMemoryError
            message = str(exc).lower()
            if "out of memory" in message or "can't allocate memory" in message:
                _free_accelerator_cache(torch)
                raise BackendError("out_of_memory", str(exc)) from exc
            raise
        finally:
            runtime.watermarker = original_watermarker
        hooks.on_progress(num_steps, num_steps)

        timings: dict[str, float] = {}
        for stage, seconds in result.stage_timings:
            timings[stage] = timings.get(stage, 0.0) + seconds * 1000.0
        timings["total_to_decode"] = float(result.total_to_decode) * 1000.0
        timings["synthesize"] = (time.perf_counter() - started) * 1000.0
        messages = [
            m
            for m in result.messages
            if request.watermark or not m.startswith(_WATERMARK_MISSING_PREFIX)
        ]
        return BackendResult(
            audios=[
                audio.detach().to(dtype=torch.float32).cpu().numpy().reshape(-1)
                for audio in result.audios
            ],
            sample_rate=int(result.sample_rate),
            used_seed=int(result.used_seed),
            timings=timings,
            messages=messages,
            watermarked=watermarked,
        )

    def _require_runtime(self) -> Any:
        runtime = self._runtime
        if runtime is None:
            raise BackendError("model_not_loaded", "no model is loaded")
        return runtime


def _free_accelerator_cache(torch: Any) -> None:
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
    mps = getattr(torch, "mps", None)
    if mps is not None and hasattr(mps, "empty_cache"):
        try:
            mps.empty_cache()
        except RuntimeError:
            pass
