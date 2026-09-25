"""OpenAI-compatible speech API (D21), shaped like Aratako/Irodori-TTS-Server so its
clients — and the OpenAI SDKs — work unchanged.

`POST /v1/audio/speech` takes `model`, `input`, `voice` (a library voice id or name, or
`none`), `response_format`, `speed`, `stream_format: "sse"` and the `irodori` extension
(sampling parameters, caption, LoRA, references, chunking). A library voice brings its
defaults (caption, parameters, seed, LoRA); the request's own values win. Errors use
OpenAI's `{"error": {message, type, param, code}}` with this app's error codes.
"""

from __future__ import annotations

import asyncio
import base64
import json
import time
from collections.abc import AsyncIterator
from pathlib import Path
from typing import TYPE_CHECKING, Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field

from app.audio.post import Post
from app.compat import speech
from app.errors import ApiError
from app.schemas import (
    ReferenceClips,
    ReferenceEmbedding,
    ReferenceInput,
    ReferenceNone,
    SamplingParams,
    Voice,
)

if TYPE_CHECKING:
    from app.services.container import Services

router = APIRouter(prefix="/v1")

MODEL_NAME = "irodori-tts"
# OpenAI's own names are accepted too, for clients that cannot change them.
MODEL_ALIASES = frozenset({MODEL_NAME, "tts-1", "tts-1-hd", "gpt-4o-mini-tts"})
CONTENT_TYPES = {
    "wav": "audio/wav",
    "mp3": "audio/mpeg",
    "flac": "audio/flac",
    "opus": "audio/opus",
    "aac": "audio/aac",
    "pcm": "audio/pcm",
}
PARAM_NAMES = frozenset(SamplingParams.model_fields)
# `irodori` options also read from the top level of the request, as upstream does.
OPTION_NAMES = PARAM_NAMES | {
    "caption", "lora_adapter", "chunking_enabled", "chunking", "chunk_min_chars",
    "first_sentence_chunk_min_chars", "ref_wav", "ref_wavs", "ref_latent", "ref_latents",
    "ref_embed", "no_ref",
}  # fmt: skip
# Options that name files on this computer: accepted from its own clients only, so a LAN
# client cannot make the app read (or load code from) arbitrary paths.
PATH_OPTIONS = ("ref_wav", "ref_wavs", "ref_embed", "lora_adapter")


class SpeechRequest(BaseModel):
    model_config = ConfigDict(extra="allow")

    model: str
    input: str = Field(min_length=1, max_length=speech.MAX_INPUT_CHARS)
    voice: str | dict[str, Any] | None = None
    response_format: str | None = None
    speed: float = Field(default=1.0, ge=0.25, le=4.0)
    stream_format: str | None = None
    irodori: dict[str, Any] = Field(default_factory=dict)


class OpenAIError(Exception):
    def __init__(self, status: int, message: str, code: str | None = None) -> None:
        super().__init__(message)
        self.status = status
        self.message = message
        self.code = code


def error_body(message: str, *, status: int, code: str | None) -> dict[str, Any]:
    kind = "invalid_request_error" if status < 500 else "server_error"
    return {"error": {"message": message, "type": kind, "param": None, "code": code}}


def error_response(exc: OpenAIError | ApiError) -> JSONResponse:
    if isinstance(exc, ApiError):
        # As upstream: the request's faults are 400, an engine that is not ready 503.
        status = 400 if exc.status_code < 500 else exc.status_code
        if speech.http_status(exc.code) == 503:
            status = 503
        return JSONResponse(
            status_code=status, content=error_body(exc.message, status=status, code=exc.code.value)
        )
    return JSONResponse(
        status_code=exc.status, content=error_body(exc.message, status=exc.status, code=exc.code)
    )


def _services(request: Request) -> Services:
    return request.app.state.services


@router.get("/models")
def list_models() -> dict[str, Any]:
    return {
        "object": "list",
        "data": [{"id": MODEL_NAME, "object": "model", "created": 0, "owned_by": "irodori-tts"}],
    }


@router.get("/audio/voices")
def list_voices(request: Request) -> dict[str, Any]:
    voices = _services(request).voices.list()
    return {"object": "list", "data": [_voice_entry(voice) for voice in voices if _usable(voice)]}


@router.get("/audio/voices/{voice_id}")
def get_voice(voice_id: str, request: Request) -> dict[str, Any]:
    voice = _find_voice(_services(request), voice_id)
    if voice is None:
        raise OpenAIError(404, f"Voice {voice_id!r} was not found.", "voice_not_found")
    return _voice_entry(voice)


@router.post("/audio/speech", response_model=None)
async def create_speech(payload: SpeechRequest, request: Request) -> Response:
    services = _services(request)
    if payload.model not in MODEL_ALIASES and payload.model != services.host.spec.id:
        raise OpenAIError(400, f"Unsupported model {payload.model!r}. Use {MODEL_NAME!r}.")
    if not payload.input.strip():
        raise OpenAIError(400, "input must contain non-whitespace text.", "text_empty")
    fmt = (payload.response_format or "wav").strip().lower()
    if fmt not in CONTENT_TYPES:
        allowed = ", ".join(sorted(CONTENT_TYPES))
        raise OpenAIError(400, f"Unsupported response_format={fmt!r}. Expected one of: {allowed}.")
    stream = _wants_sse(payload.stream_format)
    options = {k: v for k, v in (payload.model_extra or {}).items() if k in OPTION_NAMES}
    options.update(payload.irodori)
    if not _local(request) and any(options.get(name) for name in PATH_OPTIONS):
        raise OpenAIError(
            403,
            "File paths (ref_wav, ref_wavs, ref_embed, lora_adapter) are accepted only from "
            "this computer.",
            "path_not_allowed",
        )

    voice = None if _has_reference(options) else _resolve_voice(services, payload.voice)
    params = {name: options[name] for name in PARAM_NAMES if name in options}
    how = speech.voicing(
        voice, caption=options.get("caption"), params=params, lora=options.get("lora_adapter")
    )
    reference = _reference(services, options)
    if reference is not None:
        how = speech.Voicing(
            reference=reference, caption=how.caption, lora=how.lora, params=how.params
        )

    tempo = 1.0
    params = dict(how.params)
    if params.get("seconds") is not None:
        if payload.speed != 1.0:
            params["seconds"] = float(params["seconds"]) / payload.speed
    elif payload.speed != 1.0:
        base = float(params.get("duration_scale") or 1.0)
        params["duration_scale"], tempo = speech.speed_plan(services, base, payload.speed)
    how = speech.Voicing(reference=how.reference, caption=how.caption, lora=how.lora, params=params)

    chunks = _chunks(
        services, payload.input, options, has_seconds=params.get("seconds") is not None
    )
    requests = speech.requests_for(chunks, how)
    await speech.prepare(services, requests)
    post = Post(tempo=tempo) if tempo != 1.0 else None
    ffmpeg = services.config.ffmpeg

    if stream:
        return StreamingResponse(
            _events(services, requests, fmt, post, ffmpeg),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )
    started = time.perf_counter()
    parts = [await speech.speak(services, item) for item in requests]
    samples, rate = speech.joined(parts)
    audio = await _encode(samples, rate, fmt, post, ffmpeg)
    return Response(
        content=audio,
        media_type=CONTENT_TYPES[fmt],
        headers={
            "Content-Disposition": f'attachment; filename="speech.{fmt}"',
            "X-Irodori-Seed": str(parts[0].seed),
            "X-Irodori-Total-To-Decode": f"{time.perf_counter() - started:.6f}",
        },
    )


async def _events(
    services: Services, requests: list[Any], fmt: str, post: Post | None, ffmpeg: Path | None
) -> AsyncIterator[str]:
    """One `audio_chunk` event per chunk (a complete file each), then `done`."""
    completed = 0
    try:
        for index, item in enumerate(requests):
            started = time.perf_counter()
            part = await speech.speak(services, item)
            audio = await _encode(part.samples, part.rate, fmt, post, ffmpeg)
            completed += 1
            yield _sse(
                "audio_chunk",
                {
                    "index": index,
                    "text": part.text,
                    "format": fmt,
                    "media_type": CONTENT_TYPES[fmt],
                    "audio_base64": base64.b64encode(audio).decode("ascii"),
                    "seed": part.seed,
                    "total_to_decode": round(time.perf_counter() - started, 6),
                },
            )
    except ApiError as exc:
        status = exc.status_code if exc.status_code >= 400 else 400
        yield _sse("error", error_body(exc.message, status=status, code=exc.code.value))
        return
    yield _sse("done", {"chunks": completed})


async def _encode(
    samples: Any, rate: int, fmt: str, post: Post | None, ffmpeg: Path | None
) -> bytes:
    return await asyncio.to_thread(speech.encode, samples, rate, fmt, ffmpeg=ffmpeg, post=post)


def _sse(event: str, data: dict[str, Any]) -> str:
    payload = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    return f"event: {event}\ndata: {payload}\n\n"


def _wants_sse(stream_format: str | None) -> bool:
    if stream_format is None:
        return False
    if str(stream_format).strip().lower() == "sse":
        return True
    raise OpenAIError(400, "stream_format must be 'sse' when specified.")


def _chunks(
    services: Services, text: str, options: dict[str, Any], *, has_seconds: bool
) -> list[str]:
    enabled = options.get("chunking_enabled", options.get("chunking", True))
    if not enabled or has_seconds:
        return [text.strip()]
    min_chars = _positive(
        options.get("chunk_min_chars"), speech.DEFAULT_CHUNK_MIN_CHARS, "chunk_min_chars"
    )
    first = options.get("first_sentence_chunk_min_chars")
    first_min = None if first is None else _positive(first, 1, "first_sentence_chunk_min_chars")
    chunks = speech.split_for_speech(text, min_chars=min_chars, first_min_chars=first_min)
    return speech.fit_chunks(services, chunks, apply_dictionary=True)


def _positive(value: Any, default: int, name: str) -> int:
    if value is None:
        return default
    try:
        number = int(value)
    except (TypeError, ValueError) as exc:
        raise OpenAIError(400, f"{name} must be an integer.") from exc
    if number <= 0:
        raise OpenAIError(400, f"{name} must be greater than 0.")
    return number


def _local(request: Request) -> bool:
    host = request.client.host if request.client else ""
    return host == "::1" or host.startswith("127.")


def _has_reference(options: dict[str, Any]) -> bool:
    keys = ("ref_wav", "ref_wavs", "ref_embed", "no_ref", "ref_latent", "ref_latents")
    return any(options.get(key) for key in keys)


def _reference(services: Services, options: dict[str, Any]) -> ReferenceInput | None:
    """A reference given in the request (paths on this computer), if any."""
    if options.get("ref_latent") or options.get("ref_latents"):
        raise OpenAIError(
            400,
            "ref_latent / ref_latents are not supported: use ref_wav(s), ref_embed or a voice.",
            "reference_unsupported",
        )
    if options.get("no_ref"):
        return ReferenceNone()
    if options.get("ref_embed"):
        return ReferenceEmbedding(kind="embedding", path=str(options["ref_embed"]))
    paths = options.get("ref_wavs") or ([options["ref_wav"]] if options.get("ref_wav") else None)
    if paths is None:
        return None
    if not isinstance(paths, list) or not paths or not all(isinstance(p, str) for p in paths):
        raise OpenAIError(400, "ref_wavs must be a non-empty array of paths.")
    clip_ids = []
    for path in paths:
        file = Path(path)
        if not file.is_file():
            raise OpenAIError(400, f"Reference audio {path!r} was not found.", "clip_not_found")
        clip = services.clips.add_file(file, file.name, origin="upload")
        clip_ids.append(clip.clip_id)
    return ReferenceClips(kind="clips", clip_ids=clip_ids)


def _resolve_voice(services: Services, voice: str | dict[str, Any] | None) -> Voice | None:
    """A library voice by id or name; `none` (or nothing) speaks without a reference."""
    name = voice.get("id") if isinstance(voice, dict) else voice
    if name is None:
        return None
    if not isinstance(name, str) or not name.strip():
        raise OpenAIError(400, "voice must be a voice id or name.")
    if name.strip().lower() == "none":
        return None
    found = _find_voice(services, name.strip())
    if found is None:
        raise OpenAIError(400, f"Voice {name!r} was not found.", "voice_not_found")
    return found


def _find_voice(services: Services, key: str) -> Voice | None:
    voice = services.voices.get(key)
    if voice is not None:
        return voice
    return next((v for v in services.voices.list() if v.name == key), None)


def _usable(voice: Voice) -> bool:
    return not (voice.consent_required and voice.consent is None)


def _voice_entry(voice: Voice) -> dict[str, Any]:
    return {
        "id": voice.id,
        "object": "voice",
        "name": voice.name,
        "source": voice.source,
        "caption": voice.caption_default,
        "no_ref": not voice.clips and voice.embedding is None,
    }
