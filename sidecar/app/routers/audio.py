"""Audio router: GET /audio/{audio_id} streams a generated WAV (48 kHz)."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends
from fastapi.responses import FileResponse

from app.errors import ErrorCode, not_found
from app.routers.deps import services
from app.services.container import Services

router = APIRouter()

ServicesDep = Annotated[Services, Depends(services)]


@router.get("/audio/{audio_id}", response_class=FileResponse)
def audio(audio_id: str, svc: ServicesDep) -> FileResponse:
    path = svc.history.audio_path(audio_id)
    if path is None:
        raise not_found(ErrorCode.AUDIO_NOT_FOUND, "audio")
    return FileResponse(path, media_type="audio/wav", filename=f"{audio_id}.wav")
