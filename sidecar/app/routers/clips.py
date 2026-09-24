"""Clips router: reference audio — ad-hoc uploads for `ReferenceInput.kind == "clips"` and
the clips library voices own (upload first, then attach with `PATCH /voices/{id}`)."""

from __future__ import annotations

from typing import Annotated, Literal

from fastapi import APIRouter, Depends, File, Form, Response, UploadFile

from app.errors import ApiError, ErrorCode, not_found
from app.routers.deps import services
from app.schemas import ClipInfo, SplitRequest, TrimRequest
from app.services.container import Services

router = APIRouter()

ServicesDep = Annotated[Services, Depends(services)]


@router.post("/clips", response_model=ClipInfo, status_code=201)
def upload_clip(
    file: Annotated[UploadFile, File()],
    svc: ServicesDep,
    origin: Annotated[Literal["upload", "recording"], Form()] = "upload",
) -> ClipInfo:
    """Multipart upload (wav/flac/ogg/opus/mp3; other formats need ffmpeg). `origin` is
    "recording" for audio recorded in the app (both count as a real voice, D13)."""
    return svc.clips.add(file.filename or "clip", file.file, origin=origin)


@router.get("/clips/{clip_id}", response_model=ClipInfo)
def get_clip(clip_id: str, svc: ServicesDep) -> ClipInfo:
    clip = svc.clips.get(clip_id)
    if clip is None:
        raise not_found(ErrorCode.CLIP_NOT_FOUND, "clip")
    return clip


@router.get("/clips/{clip_id}/audio")
def clip_audio(clip_id: str, svc: ServicesDep) -> Response:
    """16-bit PCM WAV of the clip for playback and waveforms."""
    if svc.clips.get(clip_id) is None:
        raise not_found(ErrorCode.CLIP_NOT_FOUND, "clip")
    return Response(svc.clips.preview(clip_id), media_type="audio/wav")


@router.post("/clips/{clip_id}/trim", response_model=ClipInfo)
def trim_clip(clip_id: str, body: TrimRequest, svc: ServicesDep) -> ClipInfo:
    """Keep `start_s`..`end_s` as a new clip that replaces this one (in its voice too)."""
    return svc.clips.trim(clip_id, body.start_s, body.end_s)


@router.post("/clips/{clip_id}/split", response_model=list[ClipInfo])
def split_clip(clip_id: str, body: SplitRequest, svc: ServicesDep) -> list[ClipInfo]:
    """Cut at each position; the pieces replace this clip (in its voice too)."""
    return svc.clips.split(clip_id, body.at_s)


@router.delete("/clips/{clip_id}", status_code=204)
def delete_clip(clip_id: str, svc: ServicesDep) -> Response:
    clip = svc.clips.get(clip_id)
    if clip is None:
        raise not_found(ErrorCode.CLIP_NOT_FOUND, "clip")
    if clip.voice_id is not None:
        raise ApiError(
            ErrorCode.CLIP_IN_USE,
            "remove it from its voice instead",
            status_code=409,
            detail={"voice_id": clip.voice_id},
        )
    svc.clips.delete(clip_id)
    return Response(status_code=204)
