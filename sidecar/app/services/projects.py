"""Projects (D23): a narration or a script saved as one `.iroproj` file and opened again.

The file is a zip: `project.json` (format `iroproj`, version 1: the text, settings and
chunk / line state) and each adopted take as 16-bit FLAC under `audio/`, so the takes
come back bit for bit. Opening creates a new narration or script. Library voices and
LoRA adapters the project used that are not here are dropped, and reported, so the
project still opens (the speakers or settings then have no voice).
"""

from __future__ import annotations

import io
import json
import re
import zipfile
from pathlib import Path
from typing import Any, Literal

import numpy as np
import soundfile as sf
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from app.engine.host import EngineHost
from app.errors import ApiError, ErrorCode
from app.schemas import (
    Cue,
    ExportedFile,
    Narration,
    NarrationFormat,
    NarrationSettings,
    NarrationWarning,
    PauseKind,
    ProjectOpened,
    ProjectOpenRequest,
    ProjectSaveRequest,
    Script,
    ScriptSettings,
    ScriptSpeaker,
    SplitRules,
)
from app.services.clips import ClipStore
from app.services.history import HistoryStore
from app.services.job_manager import now_iso
from app.services.narration import MAX_CHUNKS, NarrationService, RestoredChunk
from app.services.script import MAX_LINES, RestoredLine, ScriptService
from app.services.takes import TakeAudio
from app.services.voices import VoiceService
from app.text import srt
from app.text.chunker import ChunkDraft
from app.text.script_parser import LineDraft

FORMAT = "iroproj"
VERSION = 1
EXTENSION = ".iroproj"
MAX_PROJECT_BYTES = 4 * 1024**3
MAX_JSON_BYTES = 20 * 1024**2
MAX_TAKE_BYTES = 512 * 1024**2
_TAKE_FILE = re.compile(r"^audio/\d{1,6}\.flac$")


# --- project.json ------------------------------------------------------------------------


class _Take(BaseModel):
    file: str
    seed: int = 0
    truncated: bool = False


class _Chunk(BaseModel):
    text: str = Field(min_length=1)
    pause_after: PauseKind
    estimated_seconds: float = Field(ge=0)
    cue: Cue | None = None
    take: _Take | None = None


class _Narration(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    format: NarrationFormat
    source: str
    rules: SplitRules
    settings: dict[str, Any]  # checked after its references are resolved
    warnings: list[NarrationWarning] = []
    chunks: list[_Chunk] = Field(min_length=1, max_length=MAX_CHUNKS)


class _Line(BaseModel):
    speaker: str = Field(default="", max_length=32)
    text: str = Field(min_length=1, max_length=1000)
    caption: str | None = Field(default=None, max_length=1000)
    num_candidates: int | None = Field(default=None, ge=1, le=32)
    seed: int | None = Field(default=None, ge=0, le=2**53 - 1)
    pause_ms: int | None = Field(default=None, ge=0, le=10_000)
    file_name: str | None = Field(default=None, max_length=120)
    take: _Take | None = None


class _Script(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    speakers: list[ScriptSpeaker] = Field(max_length=200)
    settings: ScriptSettings
    lines: list[_Line] = Field(min_length=1, max_length=MAX_LINES)


class _Document(BaseModel):
    model_config = ConfigDict(extra="ignore")

    format: Literal["iroproj"]
    version: int
    kind: Literal["narration", "script"]
    voices: dict[str, str] = {}  # voice id -> name, for voices this library lacks
    narration: _Narration | None = None
    script: _Script | None = None


class ProjectService:
    def __init__(
        self,
        *,
        host: EngineHost,
        narration: NarrationService,
        script: ScriptService,
        voices: VoiceService,
        clips: ClipStore,
        history: HistoryStore,
        app_version: str,
    ) -> None:
        self._host = host
        self._narration = narration
        self._script = script
        self._voices = voices
        self._clips = clips
        self._history = history
        self._app_version = app_version

    # --- Save -------------------------------------------------------------------------

    def save(self, body: ProjectSaveRequest) -> ExportedFile:
        requested = Path(body.path)
        if not requested.is_absolute() or requested.is_dir():
            raise ApiError(ErrorCode.SAVE_PATH_INVALID, "destination must be an absolute file")
        dest = (
            requested if requested.suffix.lower() == EXTENSION else Path(f"{requested}{EXTENSION}")
        )
        if not dest.parent.is_dir():
            raise ApiError(ErrorCode.SAVE_PATH_INVALID, "destination folder does not exist")
        takes: dict[str, bytes] = {}
        if body.kind == "narration":
            section, voice_ids = self._narration_section(self._narration.require(body.id), takes)
        else:
            section, voice_ids = self._script_section(self._script.require(body.id), takes)
        document = {
            "format": FORMAT,
            "version": VERSION,
            "kind": body.kind,
            "app_version": self._app_version,
            "model_id": self._host.spec.id,
            "saved_at": now_iso(),
            "voices": {
                voice_id: voice.name
                for voice_id in voice_ids
                if (voice := self._voices.get(voice_id)) is not None
            },
            body.kind: section,
        }
        partial = dest.with_name(f".{dest.name}.part")
        try:
            with zipfile.ZipFile(partial, "w", zipfile.ZIP_DEFLATED) as archive:
                archive.writestr("project.json", json.dumps(document, ensure_ascii=False, indent=1))
                for name, data in takes.items():
                    archive.writestr(name, data, compress_type=zipfile.ZIP_STORED)
            partial.replace(dest)
        except OSError as exc:
            raise ApiError(ErrorCode.SAVE_FAILED, str(exc)) from exc
        finally:
            partial.unlink(missing_ok=True)
        return ExportedFile(path=str(dest), bytes=dest.stat().st_size)

    def _narration_section(
        self, narration: Narration, takes: dict[str, bytes]
    ) -> tuple[dict[str, Any], list[str]]:
        settings = narration.settings.model_dump(mode="json")
        chunks = [
            {
                "text": chunk.text,
                "pause_after": chunk.pause_after,
                "estimated_seconds": chunk.estimated_seconds,
                "cue": chunk.cue.model_dump() if chunk.cue else None,
                "take": self._take_entry(chunk.adopted_audio_id, chunk.takes, takes),
            }
            for chunk in narration.chunks
        ]
        section = {
            "title": narration.title,
            "format": narration.format,
            "source": narration.source,
            "rules": narration.rules.model_dump(),
            "settings": settings,
            "warnings": [w.model_dump() for w in narration.warnings],
            "chunks": chunks,
        }
        reference = narration.settings.reference
        return section, [reference.voice_id] if reference.kind == "voice" else []

    def _script_section(
        self, script: Script, takes: dict[str, bytes]
    ) -> tuple[dict[str, Any], list[str]]:
        lines = [
            {
                **line.model_dump(
                    include={
                        "speaker", "text", "caption", "num_candidates", "seed", "pause_ms",
                        "file_name",
                    }
                ),
                "take": self._take_entry(line.adopted_audio_id, line.takes, takes),
            }
            for line in script.lines
        ]  # fmt: skip
        section = {
            "title": script.title,
            "speakers": [s.model_dump() for s in script.speakers],
            "settings": script.settings.model_dump(mode="json"),
            "lines": lines,
        }
        return section, [s.voice_id for s in script.speakers if s.voice_id]

    def _take_entry(
        self, audio_id: str | None, candidates: list[Any], takes: dict[str, bytes]
    ) -> dict[str, Any] | None:
        take = next((t for t in candidates if t.audio_id == audio_id), None)
        path = self._history.audio_path(audio_id) if audio_id else None
        if take is None or path is None:
            return None
        samples, rate = sf.read(str(path), dtype="int16", always_2d=False)
        buffer = io.BytesIO()
        sf.write(buffer, np.asarray(samples).reshape(-1), rate, format="FLAC", subtype="PCM_16")
        name = f"audio/{len(takes) + 1:04d}.flac"
        takes[name] = buffer.getvalue()
        return {"file": name, "seed": take.seed, "truncated": take.truncated}

    # --- Open -------------------------------------------------------------------------

    def open(self, body: ProjectOpenRequest) -> ProjectOpened:
        path = Path(body.path)
        if not path.is_absolute() or not path.is_file():
            raise ApiError(ErrorCode.SAVE_PATH_INVALID, "choose an existing project file")
        if path.stat().st_size > MAX_PROJECT_BYTES:
            raise _invalid("size")
        try:
            with zipfile.ZipFile(path) as archive:
                document = self._document(archive)
                if document.kind == "narration" and document.narration is not None:
                    return self._open_narration(archive, document)
                if document.kind == "script" and document.script is not None:
                    return self._open_script(archive, document)
                raise _invalid("content")
        except zipfile.BadZipFile as exc:
            raise _invalid("zip") from exc
        except OSError as exc:
            raise ApiError(ErrorCode.SAVE_FAILED, str(exc)) from exc

    def _document(self, archive: zipfile.ZipFile) -> _Document:
        try:
            info = archive.getinfo("project.json")
        except KeyError as exc:
            raise _invalid("content") from exc
        if info.file_size > MAX_JSON_BYTES:
            raise _invalid("size")
        try:
            raw = json.loads(archive.read(info).decode("utf-8"))
        except (ValueError, UnicodeDecodeError) as exc:
            raise _invalid("content") from exc
        if not isinstance(raw, dict) or raw.get("format") != FORMAT:
            raise _invalid("format")
        if raw.get("version") != VERSION:
            raise ApiError(
                ErrorCode.PROJECT_INVALID,
                "unsupported project version",
                status_code=422,
                detail={"reason": "version", "version": raw.get("version")},
            )
        try:
            return _Document(**raw)
        except ValidationError as exc:
            raise _invalid("content") from exc

    def _open_narration(self, archive: zipfile.ZipFile, document: _Document) -> ProjectOpened:
        section = document.narration
        assert section is not None
        missing_voices: list[str] = []
        missing_lora: list[str] = []
        settings_data = dict(section.settings)
        reference = settings_data.get("reference") or {"kind": "none"}
        if not self._reference_usable(reference):
            missing_voices.append(_reference_name(reference, document.voices))
            settings_data["reference"] = {"kind": "none"}
        lora = settings_data.get("lora_adapter")
        if lora and not Path(str(lora)).is_dir():
            missing_lora.append(str(lora))
            settings_data["lora_adapter"] = None
        try:
            settings = NarrationSettings(**settings_data)
        except ValidationError as exc:
            raise _invalid("content") from exc
        chunks = [
            RestoredChunk(
                draft=ChunkDraft(
                    text=chunk.text,
                    pause_after=chunk.pause_after,
                    estimated_seconds=chunk.estimated_seconds,
                    cue=srt.Cue(chunk.cue.start_ms, chunk.cue.end_ms, chunk.text)
                    if chunk.cue
                    else None,
                ),
                take=self._take(archive, chunk.take),
            )
            for chunk in section.chunks
        ]
        narration = self._narration.restore(
            title=section.title,
            fmt=section.format,
            source=section.source,
            rules=section.rules,
            settings=settings,
            warnings=section.warnings,
            chunks=chunks,
        )
        return ProjectOpened(
            kind="narration",
            id=narration.id,
            missing_voices=missing_voices,
            missing_lora=missing_lora,
        )

    def _open_script(self, archive: zipfile.ZipFile, document: _Document) -> ProjectOpened:
        section = document.script
        assert section is not None
        missing_voices: list[str] = []
        speakers: list[ScriptSpeaker] = []
        for speaker in section.speakers:
            if speaker.voice_id and self._voices.get(speaker.voice_id) is None:
                missing_voices.append(document.voices.get(speaker.voice_id, speaker.voice_id))
                speaker = speaker.model_copy(update={"voice_id": None})
            speakers.append(speaker)
        lines = [
            RestoredLine(
                draft=LineDraft(
                    speaker=line.speaker,
                    text=line.text,
                    caption=line.caption,
                    num_candidates=line.num_candidates,
                    seed=line.seed,
                    pause_ms=line.pause_ms,
                    file_name=line.file_name,
                ),
                take=self._take(archive, line.take),
            )
            for line in section.lines
        ]
        script = self._script.restore(
            title=section.title, speakers=speakers, settings=section.settings, lines=lines
        )
        return ProjectOpened(kind="script", id=script.id, missing_voices=missing_voices)

    def _take(self, archive: zipfile.ZipFile, take: _Take | None) -> TakeAudio | None:
        if take is None:
            return None
        if not _TAKE_FILE.match(take.file):
            raise _invalid("content")
        try:
            info = archive.getinfo(take.file)
        except KeyError as exc:
            raise _invalid("content") from exc
        if info.file_size > MAX_TAKE_BYTES:
            raise _invalid("size")
        try:
            samples, rate = sf.read(io.BytesIO(archive.read(info)), dtype="int16")
        except (RuntimeError, ValueError, sf.LibsndfileError) as exc:
            raise _invalid("audio") from exc
        if samples.ndim != 1 or len(samples) == 0:
            raise _invalid("audio")
        return TakeAudio(
            samples=samples, sample_rate=rate, seed=take.seed, truncated=take.truncated
        )

    def _reference_usable(self, reference: dict[str, Any]) -> bool:
        kind = reference.get("kind")
        if kind == "voice":
            return self._voices.get(str(reference.get("voice_id", ""))) is not None
        if kind == "clips":
            ids = reference.get("clip_ids") or []
            return bool(ids) and all(self._clips.get(str(i)) is not None for i in ids)
        if kind == "embedding":
            return Path(str(reference.get("path", ""))).is_file()
        return True


def _reference_name(reference: dict[str, Any], voices: dict[str, str]) -> str:
    kind = reference.get("kind")
    if kind == "voice":
        voice_id = str(reference.get("voice_id", ""))
        return voices.get(voice_id, voice_id)
    if kind == "embedding":
        return Path(str(reference.get("path", ""))).name
    return str(kind)


def _invalid(reason: str) -> ApiError:
    return ApiError(
        ErrorCode.PROJECT_INVALID,
        "not a readable project file",
        status_code=422,
        detail={"reason": reason},
    )
