"""Jobs router: job snapshots, SSE event streams, cancellation, and the queue (D10, D24)."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from typing import Annotated

from fastapi import APIRouter, Depends, Header
from fastapi.sse import EventSourceResponse, ServerSentEvent

from app.errors import ErrorCode, not_found
from app.routers.deps import services
from app.schemas import CancelResponse, JobInfo, QueueItem, QueueSnapshot
from app.services.container import Services
from app.services.job_manager import Job, JobEvent

router = APIRouter()

ServicesDep = Annotated[Services, Depends(services)]


def _job(job_id: str, svc: ServicesDep) -> Job:
    job = svc.jobs.get(job_id)
    if job is None:
        raise not_found(ErrorCode.JOB_NOT_FOUND, "job")
    return job


JobDep = Annotated[Job, Depends(_job)]


@router.get("/jobs/{job_id}", response_model=JobInfo)
def job_info(job: JobDep) -> JobInfo:
    return JobInfo(**job.info())


@router.get("/jobs/{job_id}/events", response_class=EventSourceResponse)
async def job_events(
    job: JobDep,
    last_event_id: Annotated[str | None, Header()] = None,
) -> AsyncIterator[ServerSentEvent]:
    """Replays the job's events, then streams new ones; ends after the terminal event
    (`completed`, `failed` or `cancelled`). `Last-Event-ID` resumes after that event."""
    after = int(last_event_id) if last_event_id and last_event_id.isdigit() else 0
    backlog, queue = job.subscribe(asyncio.get_running_loop(), after)
    try:
        for event in backlog:
            yield _sse(event)
            if event.terminal:
                return
        while queue is not None:
            event = await queue.get()
            yield _sse(event)
            if event.terminal:
                return
    finally:
        job.unsubscribe(queue)


@router.post("/jobs/{job_id}/cancel", response_model=CancelResponse)
def cancel_job(job: JobDep, svc: ServicesDep) -> CancelResponse:
    return CancelResponse(job_id=job.id, state=svc.queue.cancel(job))


@router.get("/queue", response_model=QueueSnapshot)
def queue_snapshot(svc: ServicesDep) -> QueueSnapshot:
    running, pending = svc.queue.snapshot()
    return QueueSnapshot(
        running=None if running is None else _item(running, "running"),
        queued=[_item(job, "queued") for job in pending],
    )


def _item(job: Job, state: str) -> QueueItem:
    return QueueItem(
        job_id=job.id,
        kind=job.kind,  # type: ignore[arg-type]
        source=job.source,  # type: ignore[arg-type]
        state=state,  # type: ignore[arg-type]
        created_at=job.created_at,
    )


def _sse(event: JobEvent) -> ServerSentEvent:
    return ServerSentEvent(event=event.type, id=str(event.seq), data=event.data)
