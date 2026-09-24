"""Audio router: stream a generated WAV (48 kHz), or save a copy where the user chose
(WAV, or MP3 / M4A / FLAC / Opus through ffmpeg)."""

from __future__ import annotations

from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends
from fastapi.responses import FileResponse

from app.audio import export
from app.errors import ApiError, ErrorCode, not_found
from app.routers.deps import services
from app.schemas import SaveAudioRequest, SavedFile
from app.services.container import Services

router = APIRouter()

ServicesDep = Annotated[Services, Depends(services)]


def _source(audio_id: str, svc: Services) -> Path:
    path = svc.history.audio_path(audio_id)
    if path is None:
        raise not_found(ErrorCode.AUDIO_NOT_FOUND, "audio")
    return path


@router.get("/audio/{audio_id}", response_class=FileResponse)
def audio(audio_id: str, svc: ServicesDep) -> FileResponse:
    return FileResponse(_source(audio_id, svc), media_type="audio/wav", filename=f"{audio_id}.wav")


@router.post("/audio/{audio_id}/save", response_model=SavedFile)
def save_audio(audio_id: str, body: SaveAudioRequest, svc: ServicesDep) -> SavedFile:
    """Save a copy at `path` (from the native save dialog, which already confirmed any
    overwrite), as WAV or encoded by ffmpeg. Sample rate, loudness, tempo and gain arrive
    with `POST /export` (Session 7)."""
    source = _source(audio_id, svc)
    requested = Path(body.path)
    if not requested.is_absolute() or requested.is_dir():
        raise ApiError(ErrorCode.SAVE_PATH_INVALID, "destination must be an absolute file path")
    fmt = body.format or export.format_of(requested) or "wav"
    dest = export.destination(requested, fmt)
    if not dest.parent.is_dir() or dest.is_dir():
        raise ApiError(ErrorCode.SAVE_PATH_INVALID, "destination folder does not exist")
    try:
        export.export_audio(source, dest, fmt, ffmpeg=svc.config.ffmpeg)
    except export.ExportError as exc:
        raise ApiError(ErrorCode.parse(exc.code), str(exc)) from exc
    size = dest.stat().st_size
    return SavedFile(path=str(dest), bytes=size, format=fmt)  # type: ignore[arg-type]
