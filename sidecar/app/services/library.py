"""The library (requirements §6.8): an entry's request generated again, and history audio
exported with post-processing and a naming template."""

from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Any

from app.audio import export
from app.audio.post import post_of
from app.errors import ApiError, ErrorCode
from app.schemas import (
    ExportedFile,
    HistoryEntry,
    HistoryExported,
    HistoryExportRequest,
    RegenerateRequest,
    SamplingParams,
    SynthesisRequest,
)
from app.services.history import HistoryStore
from app.services.job_manager import Job
from app.services.synthesis import SynthesisService
from app.text import naming

EXPORT_TOKENS = frozenset({"date", "n", "index", "text_head", "seed", "id"})


class LibraryService:
    def __init__(
        self, *, history: HistoryStore, synthesis: SynthesisService, ffmpeg: Path | None
    ) -> None:
        self._history = history
        self._synthesis = synthesis
        self._ffmpeg = ffmpeg

    def require(self, history_id: str) -> HistoryEntry:
        entry = self._history.get(history_id)
        if entry is None:
            raise ApiError(ErrorCode.HISTORY_NOT_FOUND, "history entry not found", status_code=404)
        return entry

    def regenerate(self, history_id: str, body: RegenerateRequest) -> tuple[Job, int]:
        """The entry's request as submitted, with its used seed unless another is given."""
        entry = self.require(history_id)
        data: dict[str, Any] = dict(entry.request)
        params = dict(data.get("params") or {})
        params["seed"] = body.seed if "seed" in body.model_fields_set else entry.used_seed
        if body.num_candidates is not None:
            params["num_candidates"] = body.num_candidates
        data["params"] = SamplingParams(**params)
        try:
            request = SynthesisRequest(**data)
        except ValueError as exc:
            raise ApiError(
                ErrorCode.INVALID_REQUEST, "the stored request is no longer valid", status_code=422
            ) from exc
        return self._synthesis.submit(request)

    def export(self, body: HistoryExportRequest) -> HistoryExported:
        folder = Path(body.folder)
        if not folder.is_absolute() or not folder.is_dir():
            raise ApiError(ErrorCode.SAVE_PATH_INVALID, "choose an existing folder")
        try:
            naming.check(body.naming_template, EXPORT_TOKENS)
        except naming.TemplateError as exc:
            raise ApiError(
                ErrorCode.NAMING_TEMPLATE_INVALID,
                "unknown template field",
                status_code=422,
                detail={"token": exc.token},
            ) from exc
        entries = [self.require(history_id) for history_id in body.history_ids]
        extension = export.EXTENSIONS[body.format]
        unique = naming.UniqueNames()
        pairs: list[tuple[Path, Path]] = []
        for n, entry in enumerate(entries, start=1):
            output = next(
                (o for o in entry.outputs if o.audio_id == entry.adopted_audio_id),
                entry.outputs[0] if entry.outputs else None,
            )
            source = self._history.audio_path(output.audio_id) if output else None
            if source is None:
                raise ApiError(ErrorCode.AUDIO_NOT_FOUND, "audio not found", status_code=404)
            values = {
                "date": _local_stamp(entry.created_at),
                "n": str(n),
                "index": naming.zero_padded(n, len(entries)),
                "text_head": entry.text[: naming.TEXT_HEAD_CHARS],
                "seed": str(entry.used_seed),
                "id": entry.id,
            }
            name = naming.safe(naming.fill(body.naming_template, values)) or f"history_{n}"
            pairs.append((source, folder / f"{unique.take(name)}{extension}"))
        try:
            export.export_many(pairs, body.format, ffmpeg=self._ffmpeg, post=post_of(body.post))
        except export.ExportError as exc:
            raise ApiError(ErrorCode.parse(exc.code), str(exc)) from exc
        return HistoryExported(
            files=[ExportedFile(path=str(dest), bytes=dest.stat().st_size) for _, dest in pairs]
        )


def _local_stamp(iso: str) -> str:
    """An ISO 8601 UTC time as the computer's local "20260925-143000"."""
    moment = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    return moment.astimezone().strftime("%Y%m%d-%H%M%S")
