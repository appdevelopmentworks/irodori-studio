"""VOICEVOX Engine-compatible API (D21), so tools that speak it (YMM4, AITuber tools, bots)
can use the app by its URL.

Each library voice is a speaker; its styles are the voice as saved ("ノーマル") and the
style presets (a caption for manner and mood). Style ids and speaker UUIDs are derived
from the voice id, so they stay the same across restarts. Irodori is not a parametric
engine: an AudioQuery carries the text in `kana` with no accent phrases; `speedScale`,
`volumeScale`, `pre/postPhonemeLength`, `outputSamplingRate` and `outputStereo` are
honored, pitch, intonation and pauses are not (docs/api-spec.md lists every deviation).
Protocol texts (speaker, style and policy strings) are Japanese data, as in VOICEVOX.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import io
import uuid
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal

import numpy as np
import soundfile as sf
from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field

from app.audio.post import Post
from app.compat import speech
from app.compat.styles import STYLES, Style
from app.errors import ApiError
from app.schemas import ApiStyle, Voice

if TYPE_CHECKING:
    from app.services.container import Services

router = APIRouter()

ENGINE_URL = "https://github.com/appdevelopmentworks/irodori-studio"
ENGINE_UUID = str(uuid.uuid5(uuid.NAMESPACE_URL, ENGINE_URL))
_SPEAKER_NAMESPACE = uuid.uuid5(uuid.NAMESPACE_URL, ENGINE_URL + "/speakers")
MANIFEST_VERSION = "0.13.1"
ICON = Path(__file__).with_name("assets") / "icon.png"
POLICY = """# irodori-studio（Irodori-TTS）

このエンジンの声は、irodori-studio のボイスライブラリに登録された声です。
音声合成モデルは Irodori-TTS（MIT License）です。

## 禁止事項（Irodori-TTS のモデルカードより）

1. 本人の明示的な同意なく、特定の人物の声を複製しないでください。
2. 誤情報や、人を欺くディープフェイクに使わないでください。
3. キャプションだけで作った声が、偶然実在の人物に似ることがあります。
4. 開発者は責任を負いません。利用者が法令を守る責任を負います。
"""


@dataclass(frozen=True)
class Resolved:
    voice: Voice
    style: Style


class AccentMora(BaseModel):
    model_config = ConfigDict(extra="allow")

    text: str = ""


class AccentPhrase(BaseModel):
    model_config = ConfigDict(extra="allow")

    moras: list[AccentMora] = []
    pause_mora: AccentMora | None = None


class AudioQuery(BaseModel):
    """VOICEVOX's AudioQuery. Irodori reads the text from `kana` (as `/audio_query`
    returns it); without it, the moras' text is spoken."""

    model_config = ConfigDict(extra="allow")

    accent_phrases: list[AccentPhrase]
    speedScale: float = Field(gt=0)  # noqa: N815 — VOICEVOX's field names
    pitchScale: float  # noqa: N815
    intonationScale: float  # noqa: N815
    volumeScale: float = Field(ge=0)  # noqa: N815
    prePhonemeLength: float = Field(ge=0)  # noqa: N815
    postPhonemeLength: float = Field(ge=0)  # noqa: N815
    pauseLength: float | None = None  # noqa: N815
    pauseLengthScale: float = 1.0  # noqa: N815
    outputSamplingRate: int = Field(gt=0, le=192_000)  # noqa: N815
    outputStereo: bool  # noqa: N815
    kana: str | None = None


def _services(request: Request) -> Services:
    return request.app.state.services


# --- Speakers and styles ----------------------------------------------------------------


def styles(services: Services) -> list[ApiStyle]:
    """Every style of every usable voice, with stable ids."""
    caption = services.host.spec.capabilities.caption
    taken: set[int] = set()
    result: list[ApiStyle] = []
    for voice in services.voices.list():
        if voice.consent_required and voice.consent is None:
            continue
        for style in STYLES if caption else STYLES[:1]:
            style_id = _style_id(voice.id, style.key)
            while style_id in taken:  # a hash collision: the later one moves on
                style_id = (style_id + 1) & 0x7FFFFFFF
            taken.add(style_id)
            result.append(
                ApiStyle(
                    style_id=style_id,
                    speaker_uuid=speaker_uuid_of(voice.id),
                    voice_id=voice.id,
                    voice_name=voice.name,
                    style=style.key,
                    name=style.name,
                )
            )
    return result


def speaker_uuid_of(voice_id: str) -> str:
    return str(uuid.uuid5(_SPEAKER_NAMESPACE, voice_id))


def _style_id(voice_id: str, style: str) -> int:
    digest = hashlib.sha1(f"{voice_id}:{style}".encode()).digest()
    return int.from_bytes(digest[:4], "big") & 0x7FFFFFFF


def _resolve(services: Services, style_id: int) -> Resolved:
    for entry in styles(services):
        if entry.style_id == style_id:
            voice = services.voices.get(entry.voice_id)
            style = next(s for s in STYLES if s.key == entry.style)
            if voice is not None:
                return Resolved(voice, style)
    raise HTTPException(status_code=422, detail=f"style id {style_id} was not found")


@router.get("/speakers")
def list_speakers(request: Request) -> list[dict[str, Any]]:
    services = _services(request)
    speakers: dict[str, dict[str, Any]] = {}
    for entry in styles(services):
        speaker = speakers.setdefault(
            entry.speaker_uuid,
            {
                "name": entry.voice_name,
                "speaker_uuid": entry.speaker_uuid,
                "styles": [],
                "version": services.config.app_version,
                "supported_features": {"permitted_synthesis_morphing": "NOTHING"},
            },
        )
        speaker["styles"].append({"name": entry.name, "id": entry.style_id, "type": "talk"})
    return list(speakers.values())


@router.get("/speaker_info")
def speaker_info(
    request: Request,
    speaker_uuid: str,
    resource_format: Literal["base64", "url"] = "base64",
) -> dict[str, Any]:
    entries = [e for e in styles(_services(request)) if e.speaker_uuid == speaker_uuid]
    if not entries:
        raise HTTPException(status_code=404, detail="speaker not found")
    icon = (
        str(request.url_for("engine_icon"))
        if resource_format == "url"
        else base64.b64encode(ICON.read_bytes()).decode("ascii")
    )
    return {
        "policy": POLICY,
        "portrait": icon,
        "style_infos": [
            {"id": e.style_id, "icon": icon, "portrait": icon, "voice_samples": []} for e in entries
        ],
    }


@router.get("/_resources/icon.png", name="engine_icon", include_in_schema=False)
def engine_icon() -> FileResponse:
    return FileResponse(ICON, media_type="image/png")


@router.post("/initialize_speaker", status_code=204)
async def initialize_speaker(request: Request, speaker: int, skip_reinit: bool = False) -> Response:
    """Encode the voice's clips for the model now, if they are not yet."""
    services = _services(request)
    resolved = _resolve(services, speaker)
    job = await asyncio.to_thread(services.voices.enqueue_encode, resolved.voice.id)
    if job is not None:
        backlog, queue = job.subscribe(asyncio.get_running_loop())
        try:
            if not any(event.terminal for event in backlog) and queue is not None:
                while not (await queue.get()).terminal:
                    pass
        finally:
            job.unsubscribe(queue)
    return Response(status_code=204)


@router.get("/is_initialized_speaker")
def is_initialized_speaker(request: Request, speaker: int) -> bool:
    voice = _resolve(_services(request), speaker).voice
    return voice.encoded or not voice.clips


# --- Queries and synthesis -------------------------------------------------------------


@router.post("/audio_query")
def audio_query(request: Request, text: str, speaker: int) -> dict[str, Any]:
    _resolve(_services(request), speaker)
    return {
        "accent_phrases": [],
        "speedScale": 1.0,
        "pitchScale": 0.0,
        "intonationScale": 1.0,
        "volumeScale": 1.0,
        "prePhonemeLength": 0.1,
        "postPhonemeLength": 0.1,
        "pauseLength": None,
        "pauseLengthScale": 1.0,
        "outputSamplingRate": 48_000,
        "outputStereo": False,
        "kana": text,
    }


@router.post("/accent_phrases")
def accent_phrases(request: Request, text: str, speaker: int) -> list[Any]:
    """Irodori does not work with accent phrases."""
    _resolve(_services(request), speaker)
    return []


@router.post("/synthesis", response_class=Response)
async def synthesis(request: Request, query: AudioQuery, speaker: int) -> Response:
    audio = await _synthesize(_services(request), query, speaker)
    return Response(content=audio, media_type="audio/wav")


@router.post("/cancellable_synthesis", response_class=Response)
async def cancellable_synthesis(request: Request, query: AudioQuery, speaker: int) -> Response:
    audio = await _synthesize(_services(request), query, speaker)
    return Response(content=audio, media_type="audio/wav")


@router.post("/multi_synthesis", response_class=Response)
async def multi_synthesis(request: Request, queries: list[AudioQuery], speaker: int) -> Response:
    services = _services(request)
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_STORED) as archive:
        for index, query in enumerate(queries, start=1):
            archive.writestr(f"{index:03d}.wav", await _synthesize(services, query, speaker))
    return Response(content=buffer.getvalue(), media_type="application/zip")


@router.post("/connect_waves", response_class=Response)
def connect_waves(waves: list[str]) -> Response:
    """WAV files (base64) joined into one; they must share rate and channels."""
    parts: list[np.ndarray] = []
    rate = channels = 0
    for wave in waves:
        try:
            data, wave_rate = sf.read(
                io.BytesIO(base64.b64decode(wave)), dtype="float32", always_2d=True
            )
        except (ValueError, RuntimeError) as exc:
            raise HTTPException(status_code=422, detail="not a readable WAV") from exc
        if parts and (wave_rate != rate or data.shape[1] != channels):
            raise HTTPException(status_code=422, detail="the waves differ in rate or channels")
        rate, channels = wave_rate, data.shape[1]
        parts.append(data)
    if not parts:
        raise HTTPException(status_code=422, detail="no waves")
    buffer = io.BytesIO()
    sf.write(buffer, np.concatenate(parts), rate, subtype="PCM_16", format="WAV")
    return Response(content=buffer.getvalue(), media_type="audio/wav")


async def _synthesize(services: Services, query: AudioQuery, style_id: int) -> bytes:
    resolved = _resolve(services, style_id)
    text = (query.kana or "").strip() or _mora_text(query)
    if not text:
        raise HTTPException(status_code=422, detail="no text: use the query from /audio_query")
    how = speech.voicing(resolved.voice, caption=resolved.style.caption)
    params = dict(how.params)
    tempo = 1.0
    if query.speedScale != 1.0:
        base = float(params.get("duration_scale") or 1.0)
        params["duration_scale"], tempo = speech.speed_plan(services, base, query.speedScale)
    how = speech.Voicing(reference=how.reference, caption=how.caption, lora=how.lora, params=params)
    chunks = speech.fit_chunks(
        services,
        speech.split_for_speech(text, min_chars=speech.DEFAULT_CHUNK_MIN_CHARS),
        apply_dictionary=True,
    )
    requests = speech.requests_for(chunks, how)
    try:
        await speech.prepare(services, requests)
        parts = [await speech.speak(services, item) for item in requests]
    except ApiError as exc:
        raise _http_error(exc) from exc
    samples, rate = speech.joined(parts)
    samples = samples * float(query.volumeScale)
    pre = np.zeros(round(query.prePhonemeLength * rate), dtype=np.float32)
    post_silence = np.zeros(round(query.postPhonemeLength * rate), dtype=np.float32)
    samples = np.concatenate([pre, samples.astype(np.float32), post_silence])
    post = Post(sample_rate=query.outputSamplingRate, tempo=tempo)
    try:
        return await asyncio.to_thread(
            speech.encode,
            samples,
            rate,
            "wav",
            ffmpeg=services.config.ffmpeg,
            post=post,
            channels=2 if query.outputStereo else 1,
        )
    except ApiError as exc:
        raise _http_error(exc) from exc


def _http_error(exc: ApiError) -> HTTPException:
    status = exc.status_code if exc.status_code >= 400 else 400
    return HTTPException(status_code=status, detail=f"{exc.code.value}: {exc.message}")


def _mora_text(query: AudioQuery) -> str:
    """Katakana from the accent phrases (a query that another engine made)."""
    words = []
    for phrase in query.accent_phrases:
        words.append("".join(mora.text for mora in phrase.moras))
        if phrase.pause_mora is not None:
            words.append("、")
    return "".join(words)


# --- Engine -----------------------------------------------------------------------------


@router.get("/version")
def version(request: Request) -> str:
    return _services(request).config.app_version


@router.get("/core_versions")
def core_versions(request: Request) -> list[str]:
    return [_services(request).config.app_version]


@router.get("/engine_manifest")
def engine_manifest() -> dict[str, Any]:
    return {
        "manifest_version": MANIFEST_VERSION,
        "name": "irodori-studio",
        "brand_name": "Irodori",
        "uuid": ENGINE_UUID,
        "url": ENGINE_URL,
        "icon": base64.b64encode(ICON.read_bytes()).decode("ascii"),
        "default_sampling_rate": 48_000,
        "frame_rate": 25.0,
        "terms_of_service": POLICY,
        "update_infos": [],
        "dependency_licenses": [
            {
                "name": "Irodori-TTS",
                "license": "MIT",
                "text": "https://github.com/Aratako/Irodori-TTS",
            }
        ],
        "supported_features": {
            "adjust_mora_pitch": False,
            "adjust_phoneme_length": False,
            "adjust_speed_scale": True,
            "adjust_pitch_scale": False,
            "adjust_intonation_scale": False,
            "adjust_volume_scale": True,
            "adjust_pause_length": False,
            "interrogative_upspeak": False,
            "synthesis_morphing": False,
            "sing": False,
            "manage_library": False,
            "return_resource_url": True,
            "apply_katakana_english": False,
            "streaming_synthesis": False,
        },
    }


@router.get("/supported_devices")
def supported_devices(request: Request) -> dict[str, bool]:
    device = _services(request).host.options.device
    return {"cpu": True, "cuda": device == "cuda", "dml": False}


@router.get("/presets")
def presets() -> list[Any]:
    return []


@router.get("/user_dict")
def user_dict() -> dict[str, Any]:
    return {}


@router.get("/singers")
def singers() -> list[Any]:
    return []
