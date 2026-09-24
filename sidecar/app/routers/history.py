"""History router (basic, D23): paged list, one entry with its full request, delete."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Query, Response

from app.errors import ErrorCode, not_found
from app.routers.deps import services
from app.schemas import HistoryEntry, HistoryPage
from app.services.container import Services

router = APIRouter()

ServicesDep = Annotated[Services, Depends(services)]


@router.get("/history", response_model=HistoryPage)
def list_history(
    svc: ServicesDep,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
    q: Annotated[str | None, Query(max_length=200)] = None,
) -> HistoryPage:
    """Newest first; `q` matches text or caption."""
    return svc.history.list(limit=limit, offset=offset, query=q or None)


@router.get("/history/{history_id}", response_model=HistoryEntry)
def get_history(history_id: str, svc: ServicesDep) -> HistoryEntry:
    entry = svc.history.get(history_id)
    if entry is None:
        raise not_found(ErrorCode.HISTORY_NOT_FOUND, "history entry")
    return entry


@router.delete("/history/{history_id}", status_code=204)
def delete_history(history_id: str, svc: ServicesDep) -> Response:
    if not svc.history.delete(history_id):
        raise not_found(ErrorCode.HISTORY_NOT_FOUND, "history entry")
    return Response(status_code=204)
