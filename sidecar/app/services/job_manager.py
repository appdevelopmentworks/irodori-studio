"""Jobs and their event streams (D10): long-running work returns a job id; clients follow
`GET /jobs/{id}/events` (SSE) and may cancel.

Events are produced on worker threads and kept per job (so a late or reconnecting
subscriber replays them); each SSE subscriber gets its own asyncio queue fed through
`loop.call_soon_threadsafe`.
"""

from __future__ import annotations

import asyncio
import threading
from collections import OrderedDict
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from app.storage.files import new_id

TERMINAL_EVENTS = frozenset({"completed", "failed", "cancelled"})


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


@dataclass(frozen=True)
class JobEvent:
    seq: int
    type: str
    data: dict[str, Any]

    @property
    def terminal(self) -> bool:
        return self.type in TERMINAL_EVENTS


class Job:
    def __init__(self, kind: str, source: str, payload: Any) -> None:
        self.id = new_id()
        self.kind = kind
        self.source = source
        self.payload = payload
        self.created_at = now_iso()
        self.started_at: str | None = None
        self.finished_at: str | None = None
        self.state = "queued"
        self.queue_position: int | None = None
        self.error: dict[str, str] | None = None
        self.result: dict[str, Any] | None = None
        self.cancel_requested = threading.Event()
        self._lock = threading.Lock()
        self._events: list[JobEvent] = []
        self._subscribers: list[tuple[asyncio.AbstractEventLoop, asyncio.Queue[JobEvent]]] = []

    @property
    def finished(self) -> bool:
        return self.state in TERMINAL_EVENTS

    # --- Events -----------------------------------------------------------------------

    def emit(self, type_: str, **data: Any) -> None:
        with self._lock:
            if self.finished:
                return  # nothing follows a terminal event
            event = JobEvent(seq=len(self._events) + 1, type=type_, data=data)
            self._events.append(event)
            if event.terminal:
                self.state = type_
                self.finished_at = now_iso()
            subscribers = list(self._subscribers)
            if event.terminal:
                self._subscribers.clear()
        for loop, queue in subscribers:
            try:
                loop.call_soon_threadsafe(queue.put_nowait, event)
            except RuntimeError:
                pass  # the subscriber's loop is gone

    def subscribe(
        self, loop: asyncio.AbstractEventLoop, after_seq: int = 0
    ) -> tuple[list[JobEvent], asyncio.Queue[JobEvent] | None]:
        """Backlog after `after_seq`, plus a live queue unless the job already finished."""
        with self._lock:
            backlog = self._events[after_seq:]
            if self.finished:
                return backlog, None
            queue: asyncio.Queue[JobEvent] = asyncio.Queue()
            self._subscribers.append((loop, queue))
            return backlog, queue

    def unsubscribe(self, queue: asyncio.Queue[JobEvent] | None) -> None:
        with self._lock:
            self._subscribers = [(lp, q) for lp, q in self._subscribers if q is not queue]

    def events(self) -> list[JobEvent]:
        with self._lock:
            return list(self._events)

    # --- State transitions ------------------------------------------------------------

    def set_position(self, position: int) -> None:
        if self.state == "queued" and position != self.queue_position:
            self.queue_position = position
            self.emit("queued", position=position)

    def mark_started(self) -> None:
        self.state = "running"
        self.queue_position = None
        self.started_at = now_iso()
        self.emit("started")

    def mark_completed(self, result: dict[str, Any]) -> None:
        self.result = result
        self.emit("completed", **result)

    def mark_failed(self, code: str, message: str) -> None:
        self.error = {"code": code, "message": message}
        self.emit("failed", code=code, message=message)

    def mark_cancelled(self) -> None:
        self.queue_position = None
        self.emit("cancelled")

    def info(self) -> dict[str, Any]:
        return {
            "job_id": self.id,
            "kind": self.kind,
            "state": self.state,
            "queue_position": self.queue_position,
            "created_at": self.created_at,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "error": self.error,
            "result": self.result,
        }


class JobManager:
    """Recent jobs by id. Finished jobs beyond `keep_finished` are forgotten (their
    results live on in history)."""

    def __init__(self, keep_finished: int = 200) -> None:
        self._jobs: OrderedDict[str, Job] = OrderedDict()
        self._lock = threading.Lock()
        self._keep_finished = keep_finished

    def create(self, kind: str, source: str, payload: Any) -> Job:
        job = Job(kind, source, payload)
        with self._lock:
            self._jobs[job.id] = job
            self._prune()
        return job

    def get(self, job_id: str) -> Job | None:
        with self._lock:
            return self._jobs.get(job_id)

    def _prune(self) -> None:
        finished = [job_id for job_id, job in self._jobs.items() if job.finished]
        for job_id in finished[: max(0, len(finished) - self._keep_finished)]:
            del self._jobs[job_id]
