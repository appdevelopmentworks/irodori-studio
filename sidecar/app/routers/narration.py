"""Narration router: long-form manuscripts split into chunks, rendered on the synthesis
queue, assembled and exported with subtitles (requirements §6.6, D18)."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Response

from app.errors import ErrorCode, not_found
from app.routers.deps import services
from app.schemas import (
    AssembledNarration,
    ChunkPatch,
    JobAccepted,
    Narration,
    NarrationCreate,
    NarrationExported,
    NarrationExportRequest,
    NarrationPatch,
    NarrationSplit,
    NarrationSummary,
    RenderRequest,
)
from app.services.container import Services

router = APIRouter()

ServicesDep = Annotated[Services, Depends(services)]


@router.get("/narrations", response_model=list[NarrationSummary])
def list_narrations(svc: ServicesDep) -> list[NarrationSummary]:
    return svc.narration.list()


@router.post("/narrations", response_model=Narration, status_code=201)
def create_narration(body: NarrationCreate, svc: ServicesDep) -> Narration:
    """Split the manuscript (text, Markdown or SRT/WebVTT) into chunks and keep them."""
    return svc.narration.create(body)


@router.get("/narrations/{narration_id}", response_model=Narration)
def get_narration(narration_id: str, svc: ServicesDep) -> Narration:
    return svc.narration.require(narration_id)


@router.patch("/narrations/{narration_id}", response_model=Narration)
def update_narration(narration_id: str, body: NarrationPatch, svc: ServicesDep) -> Narration:
    return svc.narration.update(narration_id, body)


@router.delete("/narrations/{narration_id}", status_code=204)
def delete_narration(narration_id: str, svc: ServicesDep) -> Response:
    if not svc.narration.delete(narration_id):
        raise not_found(ErrorCode.NARRATION_NOT_FOUND, "narration")
    return Response(status_code=204)


@router.post("/narrations/{narration_id}/split", response_model=Narration)
def split_narration(narration_id: str, body: NarrationSplit, svc: ServicesDep) -> Narration:
    """Split again (new manuscript or rules); every take is discarded."""
    return svc.narration.resplit(narration_id, body)


@router.patch("/narrations/{narration_id}/chunks/{index}", response_model=Narration)
def update_chunk(narration_id: str, index: int, body: ChunkPatch, svc: ServicesDep) -> Narration:
    """Edit a chunk's text (its takes are discarded) or adopt one of its takes."""
    return svc.narration.update_chunk(narration_id, index, body)


@router.post("/narrations/{narration_id}/render", response_model=JobAccepted | None)
def render_narration(
    narration_id: str, body: RenderRequest, svc: ServicesDep
) -> JobAccepted | None:
    """Render chunks in order as one job; `null` when nothing needs rendering."""
    job = svc.narration.enqueue_render(narration_id, body)
    if job is None:
        return None
    return JobAccepted(job_id=job.id, queue_position=job.queue_position or 0)


@router.post("/narrations/{narration_id}/assemble", response_model=AssembledNarration)
def assemble_narration(narration_id: str, svc: ServicesDep) -> AssembledNarration:
    return svc.narration.assemble(narration_id)


@router.post("/narrations/{narration_id}/export", response_model=NarrationExported)
def export_narration(
    narration_id: str, body: NarrationExportRequest, svc: ServicesDep
) -> NarrationExported:
    return svc.narration.export(narration_id, body)
