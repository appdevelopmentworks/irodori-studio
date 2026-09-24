"""History router (D23, requirements §6.8): paged and filtered list, one entry with its
full request, adopting a candidate, generating an entry again, exporting entries, usage
and delete."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Query, Response

from app.errors import ErrorCode, not_found
from app.routers.deps import services
from app.schemas import (
    HistoryEntry,
    HistoryExported,
    HistoryExportRequest,
    HistoryPage,
    HistoryPatch,
    HistoryUsage,
    JobAccepted,
    RegenerateRequest,
)
from app.services.container import Services
from app.services.history import HistoryFilter

router = APIRouter()

ServicesDep = Annotated[Services, Depends(services)]


@router.get("/history", response_model=HistoryPage)
def list_history(
    svc: ServicesDep,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
    q: Annotated[str | None, Query(max_length=200)] = None,
    voice: Annotated[str | None, Query(max_length=40)] = None,
    since: Annotated[str | None, Query(max_length=40)] = None,
    before: Annotated[str | None, Query(max_length=40)] = None,
) -> HistoryPage:
    """Newest first. `q` matches text or caption; `voice` is a library voice id or `none`
    (no library voice); `since` (inclusive) and `before` (exclusive) are ISO 8601 UTC."""
    filters = HistoryFilter(
        query=q or None, voice=voice or None, since=since or None, before=before or None
    )
    return svc.history.list(limit=limit, offset=offset, filters=filters)


@router.get("/history/usage", response_model=HistoryUsage)
def history_usage(svc: ServicesDep) -> HistoryUsage:
    """Entries and bytes the history holds (pruned to the limits in preferences)."""
    return svc.history.usage()


@router.post("/history/export", response_model=HistoryExported)
def export_history(body: HistoryExportRequest, svc: ServicesDep) -> HistoryExported:
    """Each entry's adopted candidate (else its first) into a folder, named by the
    template, with post-processing (D20)."""
    return svc.library.export(body)


@router.get("/history/{history_id}", response_model=HistoryEntry)
def get_history(history_id: str, svc: ServicesDep) -> HistoryEntry:
    entry = svc.history.get(history_id)
    if entry is None:
        raise not_found(ErrorCode.HISTORY_NOT_FOUND, "history entry")
    return entry


@router.patch("/history/{history_id}", response_model=HistoryEntry)
def update_history(history_id: str, body: HistoryPatch, svc: ServicesDep) -> HistoryEntry:
    """Adopt one candidate (or clear the choice with `null`)."""
    entry = svc.history.set_adopted(history_id, body.adopted_audio_id)
    if entry is None:
        raise not_found(ErrorCode.HISTORY_NOT_FOUND, "history entry")
    return entry


@router.post("/history/{history_id}/regenerate", response_model=JobAccepted, status_code=202)
def regenerate(history_id: str, body: RegenerateRequest, svc: ServicesDep) -> JobAccepted:
    """The entry's request again (a new history entry); its used seed unless `seed` is
    given (`null`: a new random one)."""
    job, position = svc.library.regenerate(history_id, body)
    return JobAccepted(job_id=job.id, queue_position=position)


@router.delete("/history/{history_id}", status_code=204)
def delete_history(history_id: str, svc: ServicesDep) -> Response:
    if not svc.history.delete(history_id):
        raise not_found(ErrorCode.HISTORY_NOT_FOUND, "history entry")
    return Response(status_code=204)
