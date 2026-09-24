"""Single generations (`POST /tts/generate`): validation at submit time, then execution on
the queue's worker thread with SSE events

    queued {position} -> started -> log / progress ... -> candidate x N -> completed

or `failed {code, message}` / `cancelled`.
"""

from __future__ import annotations

import hashlib
import logging
import secrets
import shutil
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from app.engine import params as param_table
from app.engine.base import BackendError, BackendHooks, BackendRequest, SynthesisCancelled
from app.engine.host import EngineHost
from app.errors import ApiError, ErrorCode
from app.schemas import SynthesisRequest, TtsResult
from app.services.clips import ClipStore
from app.services.history import HistoryStore, NewEntry
from app.services.job_manager import Job, JobManager
from app.services.policy import watermark_policy
from app.services.preferences import PreferencesStore
from app.services.queue import SynthesisQueue
from app.services.voices import VoiceService, inspect_embedding

log = logging.getLogger("irodori.synthesis")

MAX_TEXT_CHARS = 2000
MAX_CAPTION_CHARS = 1000


@dataclass(frozen=True)
class PreparedSynthesis:
    request: SynthesisRequest
    text: str
    caption: str | None
    params: dict[str, object]  # resolved, incl. `seed` (None = draw one at run time)
    clip_ids: tuple[str, ...] = ()
    embedding: Path | None = None
    lora: Path | None = None


class SynthesisService:
    def __init__(
        self,
        *,
        host: EngineHost,
        clips: ClipStore,
        history: HistoryStore,
        preferences: PreferencesStore,
        jobs: JobManager,
        queue: SynthesisQueue,
        voices: VoiceService,
        tmp_dir: Path,
    ) -> None:
        self._host = host
        self._clips = clips
        self._history = history
        self._preferences = preferences
        self._jobs = jobs
        self._queue = queue
        self._voices = voices
        self._tmp_dir = tmp_dir

    # --- Submit (request thread) --------------------------------------------------------

    def submit(self, request: SynthesisRequest, *, source: str = "ui") -> tuple[Job, int]:
        prepared = self.prepare(request)
        job = self._jobs.create("tts", source, prepared)
        position = self._queue.submit(job)
        return job, position

    def prepare(self, request: SynthesisRequest) -> PreparedSynthesis:
        caps = self._host.spec.capabilities
        text = request.text.strip()
        if not text:
            raise ApiError(ErrorCode.TEXT_EMPTY, "text is empty", status_code=422)
        if len(text) > MAX_TEXT_CHARS:
            raise _too_long("text", MAX_TEXT_CHARS)
        caption = (request.caption or "").strip() or None
        if caption is not None:
            if not caps.caption:
                raise ApiError(ErrorCode.CAPTION_UNSUPPORTED, "model has no caption input")
            if len(caption) > MAX_CAPTION_CHARS:
                raise _too_long("caption", MAX_CAPTION_CHARS)

        reference = request.reference
        clip_ids: tuple[str, ...] = ()
        embedding: Path | None = None
        if reference.kind == "voice":
            # The voice's identity only: its defaults are applied by the client (the Quick
            # screen form, later the compat APIs), so the request stays literal.
            clip_ids, embedding = self._voices.reference(reference.voice_id)
        if reference.kind == "clips":
            if not caps.speaker_reference:
                raise ApiError(ErrorCode.REFERENCE_UNSUPPORTED, "model has no reference input")
            for clip_id in reference.clip_ids:
                if self._clips.get(clip_id) is None:
                    raise ApiError(
                        ErrorCode.CLIP_NOT_FOUND,
                        "clip not found",
                        status_code=404,
                        detail={"clip_id": clip_id},
                    )
            clip_ids = tuple(reference.clip_ids)
        if reference.kind == "embedding":
            if not caps.speaker_embedding:
                raise ApiError(ErrorCode.REFERENCE_UNSUPPORTED, "model has no embedding input")
            embedding = Path(reference.path)
            if not (embedding.is_absolute() and embedding.is_file()):
                raise ApiError(ErrorCode.EMBEDDING_NOT_FOUND, "embedding file not found")
            inspect_embedding(embedding, expected_dim=self._host.speaker_dim)
            embedding = self._suffixed_embedding(embedding)

        lora: Path | None = None
        if request.lora_adapter and request.lora_adapter.strip():
            if not caps.lora:
                raise ApiError(ErrorCode.LORA_UNSUPPORTED, "model does not accept LoRA")
            if self._host.options.compile_model:
                raise ApiError(ErrorCode.LORA_INCOMPATIBLE_WITH_COMPILE, "disable compile first")
            lora = Path(request.lora_adapter.strip())
            if not (lora.is_absolute() and (lora / "adapter_config.json").is_file()):
                raise ApiError(ErrorCode.LORA_NOT_FOUND, "LoRA adapter directory not found")

        try:
            values = param_table.resolve(
                request.params.model_dump(exclude_unset=True),
                caps,
                reference_kind=reference.kind,
                has_caption=caption is not None,
            )
        except param_table.ParamError as exc:
            raise ApiError(
                ErrorCode.INVALID_PARAMS,
                str(exc),
                status_code=422,
                detail={"param": exc.name, "reason": exc.reason},
            ) from exc
        return PreparedSynthesis(
            request=request,
            text=text,
            caption=caption,
            params=values,
            clip_ids=clip_ids,
            embedding=embedding,
            lora=lora,
        )

    # --- Execute (worker thread) --------------------------------------------------------

    def execute(self, job: Job) -> None:
        prepared: PreparedSynthesis = job.payload
        if job.cancel_requested.is_set():
            job.mark_cancelled()
            return
        job.mark_started()
        try:
            result = self._run(job, prepared)
        except SynthesisCancelled:
            job.mark_cancelled()
            return
        except BackendError as exc:
            log.warning("job %s failed: %s %s", job.id, exc.code, exc.message)
            job.mark_failed(ErrorCode.parse(exc.code).value, exc.message)
            return
        except ApiError as exc:
            job.mark_failed(exc.code.value, exc.message)
            return
        except Exception as exc:
            log.exception("job %s failed", job.id)
            job.mark_failed(ErrorCode.SYNTHESIS_FAILED.value, f"{type(exc).__name__}: {exc}")
            return
        if result is None:
            job.mark_cancelled()
            return
        for output in result.outputs:
            job.emit("candidate", **output.model_dump())
        job.mark_completed(result.model_dump())

    def _run(self, job: Job, prepared: PreparedSynthesis) -> TtsResult | None:
        backend = self._host.backend()
        spec = self._host.spec
        options = self._host.options
        preferences = self._preferences.get()
        watermark = watermark_policy(prepared.request, preferences)
        if watermark and not backend.watermark_ready:
            # D12: default ON must never lapse silently.
            raise BackendError(ErrorCode.WATERMARK_UNAVAILABLE.value, "watermarker not loaded")

        def on_log(line: str) -> None:
            log.info("[%s] %s", job.id, line)
            job.emit("log", line=line)

        hooks = BackendHooks(
            on_log=on_log,
            on_progress=lambda done, total: job.emit(
                "progress", done=done, total=total, unit="step"
            ),
            is_cancelled=job.cancel_requested.is_set,
        )
        timings: dict[str, float] = {}
        ref_latents: list[Path] = []
        if prepared.clip_ids:
            started = time.perf_counter()
            ref_latents, encoded = self._clips.latents(
                prepared.clip_ids,
                backend=backend,
                spec=spec,
                options=options,
                normalize_db=prepared.params.get("ref_normalize_db"),  # type: ignore[arg-type]
                ensure_max=bool(prepared.params.get("ref_ensure_max", True)),
                on_log=on_log,
            )
            if encoded:  # absent when every clip came from the latent cache
                timings["encode_reference"] = (time.perf_counter() - started) * 1000.0
        if job.cancel_requested.is_set():
            return None

        values = dict(prepared.params)
        seed = values.pop("seed")
        if seed is None:
            seed = secrets.randbelow(param_table.MAX_SEED + 1)
        result = backend.synthesize(
            BackendRequest(
                text=prepared.text,
                caption=prepared.caption,
                ref_latents=tuple(ref_latents),
                ref_embed=prepared.embedding,
                lora_adapter=prepared.lora,
                params=values,
                seed=int(seed),  # type: ignore[arg-type]
                watermark=watermark,
            ),
            hooks,
        )
        if job.cancel_requested.is_set():
            return None
        timings.update(result.timings)

        started = time.perf_counter()
        # As submitted (unset fields stay absent); `params` holds every value actually used.
        request_dump: dict[str, Any] = prepared.request.model_dump(mode="json", exclude_unset=True)
        history_id, outputs = self._history.record(
            NewEntry(
                model_id=spec.id,
                text=prepared.text,
                caption=prepared.caption,
                reference_kind=prepared.request.reference.kind,
                request=request_dump,
                params={**prepared.params, "seed": result.used_seed},
                used_seed=result.used_seed,
                timings=timings,
                messages=result.messages,
                watermarked=result.watermarked,
                device=options.device,
                precision=options.model_precision,
            ),
            result.audios,
            result.sample_rate,
        )
        timings["write_audio"] = (time.perf_counter() - started) * 1000.0
        self._history.prune(preferences)
        return TtsResult(
            history_id=history_id,
            used_seed=result.used_seed,
            timings={name: round(ms, 1) for name, ms in timings.items()},
            outputs=outputs,
            watermarked=result.watermarked,
        )

    def _suffixed_embedding(self, path: Path) -> Path:
        """Upstream loads Speaker Inversion files only by their `.speaker.safetensors`
        suffix; any other name is served from a content-addressed copy."""
        if path.name.endswith(".speaker.safetensors"):
            return path
        digest = hashlib.sha256(path.read_bytes()).hexdigest()[:24]
        copy = self._tmp_dir / "embeddings" / f"{digest}.speaker.safetensors"
        if not copy.is_file():
            copy.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, copy)
        return copy


def _too_long(field: str, limit: int) -> ApiError:
    return ApiError(
        ErrorCode.TEXT_TOO_LONG,
        f"{field} is too long",
        status_code=422,
        detail={"field": field, "max_chars": limit},
    )
