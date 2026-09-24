"""The single synthesis queue (D24): one job at a time, FIFO, shared by the UI and the
external API. Queued jobs learn their position through `queued {position}` events and
can be cancelled; a running job is cancelled cooperatively (D27).
"""

from __future__ import annotations

import logging
import threading
from collections import deque
from collections.abc import Callable
from typing import Literal

from app.errors import ErrorCode
from app.services.job_manager import Job

log = logging.getLogger("irodori.queue")

CancelOutcome = Literal["cancelled", "cancelling", "completed", "failed"]


class SynthesisQueue:
    def __init__(
        self,
        execute: Callable[[Job], None],
        engine_settled: Callable[[float], bool],
    ) -> None:
        """`execute` runs one job on the worker thread; `engine_settled(timeout)` blocks
        until the model is ready or failed, so jobs stay queued (and cancellable) while
        it loads."""
        self._execute = execute
        self._engine_settled = engine_settled
        self._cv = threading.Condition()
        self._pending: deque[Job] = deque()
        self._running: Job | None = None
        self._stopping = False
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        with self._cv:
            if self._thread is not None:
                return
            self._stopping = False
            self._thread = threading.Thread(target=self._work, name="synthesis", daemon=True)
            self._thread.start()

    def stop(self, timeout: float = 5.0) -> None:
        with self._cv:
            self._stopping = True
            running = self._running
            self._cv.notify_all()
        if running is not None:
            running.cancel_requested.set()
        if self._thread is not None:
            self._thread.join(timeout)
            self._thread = None

    def submit(self, job: Job) -> int:
        with self._cv:
            self._pending.append(job)
            position = self._position_of(len(self._pending) - 1)
            job.set_position(position)
            self._cv.notify_all()
        return position

    def cancel(self, job: Job) -> CancelOutcome:
        with self._cv:
            if job in self._pending:
                self._pending.remove(job)
                job.mark_cancelled()
                self._announce_positions()
                return "cancelled"
        if not job.finished:  # running, or just taken by the worker
            job.cancel_requested.set()
            return "cancelling"
        return job.state  # type: ignore[return-value] - already finished

    def snapshot(self) -> tuple[Job | None, list[Job]]:
        with self._cv:
            return self._running, list(self._pending)

    def __len__(self) -> int:
        with self._cv:
            return len(self._pending) + (1 if self._running is not None else 0)

    # --- Worker -----------------------------------------------------------------------

    def _position_of(self, index: int) -> int:
        return index + (1 if self._running is not None else 0)

    def _announce_positions(self) -> None:
        for index, queued in enumerate(self._pending):
            queued.set_position(self._position_of(index))

    def _work(self) -> None:
        while True:
            with self._cv:
                while not self._stopping and not self._pending:
                    self._cv.wait()
                if self._stopping:
                    return
            # Wait for the model outside the lock; re-check the queue after each slice.
            if not self._engine_settled(0.5):
                continue
            with self._cv:
                if self._stopping:
                    return
                if not self._pending:
                    continue
                job = self._pending.popleft()
                self._running = job
                self._announce_positions()
            try:
                self._execute(job)
            except Exception as exc:  # never let one job kill the worker
                log.exception("job %s crashed", job.id)
                job.mark_failed(ErrorCode.INTERNAL_ERROR.value, type(exc).__name__)
            finally:
                with self._cv:
                    self._running = None
                    self._announce_positions()
