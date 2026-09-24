"""Voices router: the voice library (requirements §6.5, D13, D22)."""

from __future__ import annotations

from typing import Annotated
from urllib.parse import quote

from fastapi import APIRouter, Depends, File, Response, UploadFile

from app.errors import ErrorCode, not_found
from app.routers.deps import services
from app.schemas import (
    ExportedFile,
    ExportRequest,
    JobAccepted,
    Voice,
    VoiceCreate,
    VoicePatch,
    VoiceSaved,
)
from app.services.container import Services

router = APIRouter()

ServicesDep = Annotated[Services, Depends(services)]


@router.get("/voices", response_model=list[Voice])
def list_voices(svc: ServicesDep) -> list[Voice]:
    return svc.voices.list()


@router.post("/voices", response_model=VoiceSaved, status_code=201)
def create_voice(body: VoiceCreate, svc: ServicesDep) -> VoiceSaved:
    """Imported and recorded voices need `consent` (D13). Clips come from `POST /clips`."""
    return svc.voices.create(body)


@router.post("/voices/import", response_model=VoiceSaved, status_code=201)
def import_voice(file: Annotated[UploadFile, File()], svc: ServicesDep) -> VoiceSaved:
    """An `.irovoice` package (D22); its consent record comes along."""
    return svc.voices.import_package(file.file)


@router.get("/voices/{voice_id}", response_model=Voice)
def get_voice(voice_id: str, svc: ServicesDep) -> Voice:
    return svc.voices.require(voice_id)


@router.patch("/voices/{voice_id}", response_model=VoiceSaved)
def update_voice(voice_id: str, body: VoicePatch, svc: ServicesDep) -> VoiceSaved:
    return svc.voices.update(voice_id, body)


@router.delete("/voices/{voice_id}", status_code=204)
def delete_voice(voice_id: str, svc: ServicesDep) -> Response:
    """Deletes the voice together with its clips (recordings do not linger, D13)."""
    if not svc.voices.delete(voice_id):
        raise not_found(ErrorCode.VOICE_NOT_FOUND, "voice")
    return Response(status_code=204)


@router.post("/voices/{voice_id}/encode", response_model=JobAccepted | None)
def encode_voice(voice_id: str, svc: ServicesDep) -> JobAccepted | None:
    """Encode the voice's clips for the active model now; `null` when already cached."""
    job = svc.voices.enqueue_encode(voice_id)
    if job is None:
        return None
    return JobAccepted(job_id=job.id, queue_position=job.queue_position or 0)


@router.post("/voices/{voice_id}/export", response_model=ExportedFile)
def export_voice_to(voice_id: str, body: ExportRequest, svc: ServicesDep) -> ExportedFile:
    """Write the package to `path` (from the native save dialog; `.irovoice` is appended
    when missing)."""
    return svc.voices.export_to(voice_id, body.path)


@router.get("/voices/{voice_id}/export")
def export_voice(voice_id: str, svc: ServicesDep) -> Response:
    filename, data = svc.voices.export(voice_id)
    disposition = f"attachment; filename*=UTF-8''{quote(filename)}"
    return Response(
        data,
        media_type="application/zip",
        headers={"Content-Disposition": disposition},
    )
