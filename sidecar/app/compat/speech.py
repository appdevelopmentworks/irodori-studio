"""What the external APIs share (D21): speaking a text with a voice through the one
synthesis queue (D24), and encoding the result.

A text is split into chunks the model can say in one generation; each chunk is a queued
generation, recorded in the history as `api`, and waited for without blocking the event
loop. Speeds outside the model's duration range are finished with a time stretch.
"""

from __future__ import annotations

import asyncio
import io
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

import numpy as np
import soundfile as sf

from app.audio import export
from app.audio.io import read_frames
from app.audio.post import Post
from app.engine import params as param_table
from app.errors import ApiError, ErrorCode
from app.schemas import (
    ReferenceInput,
    ReferenceNone,
    ReferenceVoice,
    SamplingParams,
    SynthesisRequest,
    Voice,
)
from app.text.chunker import split_text

if TYPE_CHECKING:
    from app.services.container import Services

# Where Irodori-TTS-Server may end a chunk (kept for parity with its clients).
CHUNK_BOUNDARIES = frozenset("。、，,．.!！?？\n\r")
DEFAULT_CHUNK_MIN_CHARS = 80
# A chunk estimated past this share of the output limit is split again by sentences.
LENGTH_MARGIN = 0.8
MAX_INPUT_CHARS = 20_000


@dataclass(frozen=True)
class Voicing:
    """How a text is spoken: the reference, caption, LoRA and parameters."""

    reference: ReferenceInput
    caption: str | None
    lora: str | None
    params: dict[str, Any]


@dataclass(frozen=True)
class Spoken:
    samples: np.ndarray  # float32, mono
    rate: int
    seed: int
    text: str


def voicing(
    voice: Voice | None,
    *,
    caption: str | None = None,
    params: dict[str, Any] | None = None,
    lora: str | None = None,
) -> Voicing:
    """A library voice's defaults (caption, parameters, seed, LoRA) under the request's
    own values; without a voice, no reference."""
    merged: dict[str, Any] = dict(voice.params_default) if voice else {}
    if voice is not None and voice.seed_default is not None:
        merged.setdefault("seed", voice.seed_default)
    merged.update(params or {})
    return Voicing(
        reference=ReferenceVoice(kind="voice", voice_id=voice.id) if voice else ReferenceNone(),
        caption=caption if caption is not None else (voice.caption_default if voice else None),
        lora=lora if lora is not None else (voice.lora_path if voice else None),
        params=merged,
    )


def speed_plan(services: Services, base_scale: float, speed: float) -> tuple[float, float]:
    """(duration_scale within the model's range, the tempo change left for the time
    stretch). `speed` > 1 is faster; `duration_scale` is length, so it is 1 / speed."""
    wanted = base_scale / speed
    limits = param_table.bounds("duration_scale", services.host.spec.capabilities)
    if limits is None:  # no duration predictor: all of it is a time stretch
        return base_scale, speed
    low, high = limits
    scale = min(
        max(wanted, low if low is not None else wanted), high if high is not None else wanted
    )
    return scale, scale / wanted


def split_for_speech(text: str, *, min_chars: int, first_min_chars: int | None = None) -> list[str]:
    """Irodori-TTS-Server's chunking: a chunk ends at the first boundary once it has at
    least `min_chars` non-space characters (`first_min_chars` for the first one)."""
    chunks: list[str] = []
    current: list[str] = []
    count = 0
    first = first_min_chars is not None
    for char in text:
        current.append(char)
        if not char.isspace():
            count += 1
        if char not in CHUNK_BOUNDARIES:
            continue
        needed = first_min_chars if first and first_min_chars is not None else min_chars
        first = False
        if count >= needed:
            chunk = "".join(current).strip()
            if chunk:
                chunks.append(chunk)
            current, count = [], 0
    tail = "".join(current).strip()
    if tail:
        chunks.append(tail)
    return chunks or [text.strip()]


def fit_chunks(services: Services, chunks: list[str], *, apply_dictionary: bool) -> list[str]:
    """Chunks estimated too long for one generation, split again by sentences."""
    limit = services.host.spec.capabilities.max_output_seconds * LENGTH_MARGIN

    def estimate(text: str) -> float:
        spoken = services.dictionary.apply(text).text if apply_dictionary else text
        return services.reader.estimate_seconds(spoken)

    fitted: list[str] = []
    for chunk in chunks:
        if estimate(chunk) <= limit:
            fitted.append(chunk)
            continue
        drafts = split_text(chunk, min_chars=1, max_chars=400, max_seconds=limit, estimate=estimate)
        fitted.extend(draft.text for draft in drafts)
    return fitted


def requests_for(chunks: list[str], how: Voicing) -> list[SynthesisRequest]:
    return [
        SynthesisRequest(
            text=chunk,
            caption=how.caption,
            reference=how.reference,
            lora_adapter=how.lora,
            params=SamplingParams(**how.params),
        )
        for chunk in chunks
    ]


async def speak(services: Services, request: SynthesisRequest) -> Spoken:
    """One queued generation; its first candidate. Cancelled with the caller."""
    job, _ = await asyncio.to_thread(services.synthesis.submit, request, source="api")
    backlog, queue = job.subscribe(asyncio.get_running_loop())
    try:
        events = list(backlog)
        while True:
            for event in events:
                if event.type == "completed":
                    return await asyncio.to_thread(_spoken, services, event.data, request.text)
                if event.type == "failed":
                    code = ErrorCode.parse(str(event.data.get("code")))
                    message = str(event.data.get("message", ""))
                    raise ApiError(code, message, status_code=http_status(code))
                if event.type == "cancelled":
                    raise ApiError(ErrorCode.SYNTHESIS_FAILED, "cancelled", status_code=503)
            if queue is None:
                raise ApiError(
                    ErrorCode.INTERNAL_ERROR, "the job ended without a result", status_code=500
                )
            events = [await queue.get()]
    except asyncio.CancelledError:
        services.queue.cancel(job)  # the client went away
        raise
    finally:
        job.unsubscribe(queue)


async def prepare(services: Services, requests: list[SynthesisRequest]) -> None:
    """Refuse a request before anything is queued (voice, consent, LoRA, parameters)."""
    await asyncio.to_thread(services.synthesis.prepare, requests[0])


def _spoken(services: Services, result: dict[str, Any], text: str) -> Spoken:
    output = result["outputs"][0]
    path = services.history.audio_path(output["audio_id"])
    if path is None:
        raise ApiError(ErrorCode.AUDIO_NOT_FOUND, "the generated audio is gone", status_code=500)
    frames, rate = read_frames(path)
    return Spoken(
        samples=frames.mean(axis=1).astype(np.float32),
        rate=rate,
        seed=int(result["used_seed"]),
        text=text,
    )


def joined(parts: list[Spoken]) -> tuple[np.ndarray, int]:
    rate = parts[0].rate
    if any(part.rate != rate for part in parts):
        raise ApiError(ErrorCode.INTERNAL_ERROR, "chunk sample rates differ", status_code=500)
    return np.concatenate([part.samples for part in parts]), rate


def http_status(code: ErrorCode) -> int:
    """How a failure reads over HTTP: the request's fault, the engine not ready, or ours."""
    if code in _CLIENT_ERRORS:
        return 400
    if code in _UNAVAILABLE:
        return 503
    return 500


_CLIENT_ERRORS = frozenset(
    {
        ErrorCode.INVALID_REQUEST, ErrorCode.INVALID_PARAMS, ErrorCode.TEXT_EMPTY,
        ErrorCode.TEXT_TOO_LONG, ErrorCode.CAPTION_UNSUPPORTED, ErrorCode.REFERENCE_UNSUPPORTED,
        ErrorCode.LORA_UNSUPPORTED, ErrorCode.LORA_NOT_FOUND, ErrorCode.EMBEDDING_NOT_FOUND,
        ErrorCode.EMBEDDING_INVALID, ErrorCode.VOICE_NOT_FOUND, ErrorCode.CLIP_NOT_FOUND,
        ErrorCode.CONSENT_REQUIRED, ErrorCode.FFMPEG_UNAVAILABLE,
    }
)  # fmt: skip
_UNAVAILABLE = frozenset(
    {
        ErrorCode.MODEL_NOT_LOADED, ErrorCode.MODEL_LOAD_FAILED, ErrorCode.MODEL_FILES_MISSING,
        ErrorCode.WATERMARK_UNAVAILABLE, ErrorCode.TORCH_UNAVAILABLE,
    }
)  # fmt: skip


def encode(
    samples: np.ndarray,
    rate: int,
    fmt: str,
    *,
    ffmpeg: Path | None,
    post: Post | None = None,
    channels: int = 1,
) -> bytes:
    """Mono float samples as `fmt` ("wav", "pcm", "mp3", "flac", "opus", "aac"), with
    `post` (tempo, sample rate) applied; WAV and PCM need no ffmpeg unless processed."""
    if fmt not in ("wav", "pcm"):
        return _encoded(samples, rate, fmt, ffmpeg, post or Post(sample_rate=rate))
    if post is not None and not post.identity:
        samples, rate = _processed(samples, rate, post, ffmpeg)
    if fmt in ("wav", "pcm"):
        clipped = np.clip(samples, -1.0, 1.0)
        if fmt == "pcm":
            return (clipped * 32767.0).astype("<i2").tobytes()
        data = np.repeat(clipped[:, None], channels, axis=1) if channels > 1 else clipped
        buffer = io.BytesIO()
        sf.write(buffer, data, rate, subtype="PCM_16", format="WAV")
        return buffer.getvalue()
    raise ValueError(fmt)


def _encoded(samples: np.ndarray, rate: int, fmt: str, ffmpeg: Path | None, post: Post) -> bytes:
    with tempfile.TemporaryDirectory(prefix="irodori-api-") as folder:
        source = Path(folder) / "speech.wav"
        sf.write(str(source), samples, rate, subtype="FLOAT")
        dest = Path(folder) / f"speech.{fmt}"
        try:
            export.export_audio(source, dest, fmt, ffmpeg=ffmpeg, post=post)
        except export.ExportError as exc:
            raise ApiError(ErrorCode.parse(exc.code), str(exc)) from exc
        return dest.read_bytes()


def _processed(
    samples: np.ndarray, rate: int, post: Post, ffmpeg: Path | None
) -> tuple[np.ndarray, int]:
    """`post` applied through ffmpeg, back as float samples."""
    with tempfile.TemporaryDirectory(prefix="irodori-api-") as folder:
        source = Path(folder) / "in.wav"
        dest = Path(folder) / "out.wav"
        sf.write(str(source), samples, rate, subtype="FLOAT")
        try:
            export.export_audio(source, dest, "wav", ffmpeg=ffmpeg, post=post)
        except export.ExportError as exc:
            raise ApiError(ErrorCode.parse(exc.code), str(exc)) from exc
        frames, out_rate = read_frames(dest)
    return frames.mean(axis=1).astype(np.float32), out_rate
