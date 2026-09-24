"""Wires the sidecar's long-lived objects together: one registry, one resident engine
(D4), one database, one synthesis queue (D24). Routers reach them through
`request.app.state.services`.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.config import SidecarConfig
from app.engine.base import BackendFactory
from app.engine.host import EngineHost, runtime_options
from app.engine.registry import Registry, load_registry
from app.services.clips import ClipStore
from app.services.history import HistoryStore
from app.services.job_manager import Job, JobManager
from app.services.preferences import PreferencesStore
from app.services.queue import SynthesisQueue
from app.services.synthesis import SynthesisService
from app.services.voices import VoiceService
from app.storage.db import Database
from app.storage.files import DataLayout


@dataclass
class Services:
    config: SidecarConfig
    registry: Registry
    layout: DataLayout
    db: Database
    host: EngineHost
    preferences: PreferencesStore
    clips: ClipStore
    history: HistoryStore
    jobs: JobManager
    queue: SynthesisQueue
    synthesis: SynthesisService
    voices: VoiceService
    autoload: bool = True

    def start(self) -> None:
        """Begin loading the model (D4) and serving the queue."""
        self.clips.purge_unowned()
        if self.autoload:
            self.host.start()
        self.queue.start()

    def stop(self) -> None:
        self.queue.stop()
        self.db.close()


def build_services(
    config: SidecarConfig,
    *,
    backend_factory: BackendFactory | None = None,
    autoload: bool = True,
) -> Services:
    if backend_factory is None:
        from app.engine.irodori_adapter import TorchBackend

        backend_factory = TorchBackend
    registry = load_registry()
    layout = DataLayout(config.root)
    db = Database(layout.database)
    host = EngineHost(registry, runtime_options(config), config.models_root, backend_factory)
    preferences = PreferencesStore(db)
    clips = ClipStore(db, layout, config.ffmpeg)
    history = HistoryStore(db, layout)
    jobs = JobManager()
    synthesis: SynthesisService | None = None
    voices: VoiceService | None = None

    def execute(job: Job) -> None:
        # One queue for all GPU work (D24): generations and voice encoding.
        assert synthesis is not None and voices is not None
        if job.kind == "encode":
            voices.execute_encode(job)
        else:
            synthesis.execute(job)

    queue = SynthesisQueue(execute, host.wait_settled)
    voices = VoiceService(
        db=db,
        layout=layout,
        clips=clips,
        history=history,
        host=host,
        jobs=jobs,
        queue=queue,
        app_version=config.app_version,
    )
    synthesis = SynthesisService(
        host=host,
        clips=clips,
        history=history,
        preferences=preferences,
        jobs=jobs,
        queue=queue,
        voices=voices,
        tmp_dir=layout.tmp,
    )
    return Services(
        config=config,
        registry=registry,
        layout=layout,
        db=db,
        host=host,
        preferences=preferences,
        clips=clips,
        history=history,
        jobs=jobs,
        queue=queue,
        synthesis=synthesis,
        voices=voices,
        autoload=autoload,
    )
