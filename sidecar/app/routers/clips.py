"""Clips router: ad-hoc reference audio for `ReferenceInput.kind == "clips"`."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, File, Response, UploadFile

from app.errors import ErrorCode, not_found
from app.routers.deps import services
from app.schemas import ClipInfo
from app.services.container import Services

router = APIRouter()

ServicesDep = Annotated[Services, Depends(services)]


@router.post("/clips", response_model=ClipInfo, status_code=201)
def upload_clip(file: Annotated[UploadFile, File()], svc: ServicesDep) -> ClipInfo:
    """Multipart upload (wav/flac/ogg/opus/mp3; other formats need the bundled ffmpeg)."""
    return svc.clips.add(file.filename or "clip", file.file)


@router.get("/clips/{clip_id}", response_model=ClipInfo)
def get_clip(clip_id: str, svc: ServicesDep) -> ClipInfo:
    clip = svc.clips.get(clip_id)
    if clip is None:
        raise not_found(ErrorCode.CLIP_NOT_FOUND, "clip")
    return clip


@router.delete("/clips/{clip_id}", status_code=204)
def delete_clip(clip_id: str, svc: ServicesDep) -> Response:
    if not svc.clips.delete(clip_id):
        raise not_found(ErrorCode.CLIP_NOT_FOUND, "clip")
    return Response(status_code=204)
