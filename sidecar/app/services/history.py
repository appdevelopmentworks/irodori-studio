"""Generation history (D23): every generation keeps its audio files, the request as
submitted, every resolved parameter, the used seed and the timings. Oldest entries are
pruned past the count / size limits in preferences (defaults 500 entries / 5 GB).
"""

from __future__ import annotations

import json
import logging
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from app.audio.io import write_wav
from app.schemas import AudioOutput, HistoryEntry, HistoryPage, HistorySummary, Preferences
from app.services.job_manager import now_iso
from app.storage.db import Database
from app.storage.files import DataLayout, is_id, new_id, remove_tree

log = logging.getLogger("irodori.history")


@dataclass(frozen=True)
class NewEntry:
    model_id: str
    text: str
    caption: str | None
    reference_kind: str
    request: dict[str, Any]
    params: dict[str, Any]
    used_seed: int
    timings: dict[str, float]
    messages: list[str]
    watermarked: bool
    device: str
    precision: str


class HistoryStore:
    def __init__(self, db: Database, layout: DataLayout) -> None:
        self._db = db
        self._layout = layout

    def record(
        self, entry: NewEntry, audios: Sequence[np.ndarray], sample_rate: int
    ) -> tuple[str, list[AudioOutput]]:
        history_id = new_id()
        folder = self._layout.history / history_id
        outputs: list[AudioOutput] = []
        rows: list[tuple[Any, ...]] = []
        total = 0
        try:
            for index, samples in enumerate(audios):
                audio_id = new_id()
                path = folder / f"{audio_id}.wav"
                size = write_wav(path, samples, sample_rate)
                duration = round(len(samples) / float(sample_rate), 3)
                total += size
                outputs.append(AudioOutput(index=index, audio_id=audio_id, duration_s=duration))
                rows.append(
                    (audio_id, history_id, index, self._layout.to_rel(path), duration,
                     sample_rate, size)
                )  # fmt: skip
            with self._db.transaction() as conn:
                conn.execute(
                    "INSERT INTO history (id, created_at, kind, model_id, text, caption,"
                    " reference_kind, request_json, params_json, used_seed, timings_json,"
                    " messages_json, watermarked, device, precision, total_bytes)"
                    " VALUES (?, ?, 'tts', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        history_id, now_iso(), entry.model_id, entry.text, entry.caption,
                        entry.reference_kind, _dump(entry.request), _dump(entry.params),
                        entry.used_seed, _dump(entry.timings), _dump(entry.messages),
                        int(entry.watermarked), entry.device, entry.precision, total,
                    ),
                )  # fmt: skip
                conn.executemany(
                    "INSERT INTO audio (id, history_id, idx, rel_path, duration_s,"
                    " sample_rate, bytes) VALUES (?, ?, ?, ?, ?, ?, ?)",
                    rows,
                )
        except BaseException:
            remove_tree(folder)
            raise
        return history_id, outputs

    def list(self, *, limit: int, offset: int, query: str | None) -> HistoryPage:
        where, args = "", []
        if query:
            where = " WHERE text LIKE ? ESCAPE '\\' OR caption LIKE ? ESCAPE '\\'"
            pattern = "%" + query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            args = [pattern + "%", pattern + "%"]
        total = self._db.query_one(f"SELECT COUNT(*) AS n FROM history{where}", args)["n"]
        rows = self._db.query(
            f"SELECT * FROM history{where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?",
            [*args, limit, offset],
        )
        outputs = self._outputs([row["id"] for row in rows])
        return HistoryPage(items=[_summary(row, outputs) for row in rows], total=total)

    def get(self, history_id: str) -> HistoryEntry | None:
        if not is_id(history_id):
            return None
        row = self._db.query_one("SELECT * FROM history WHERE id = ?", (history_id,))
        if row is None:
            return None
        summary = _summary(row, self._outputs([history_id]))
        return HistoryEntry(
            **summary.model_dump(),
            request=json.loads(row["request_json"]),
            params=json.loads(row["params_json"]),
            timings=json.loads(row["timings_json"]),
            messages=json.loads(row["messages_json"]),
            device=row["device"],
            precision=row["precision"],
        )

    def delete(self, history_id: str) -> bool:
        if not is_id(history_id):
            return False
        with self._db.transaction() as conn:
            deleted = conn.execute("DELETE FROM history WHERE id = ?", (history_id,)).rowcount
        if deleted:
            remove_tree(self._layout.history / history_id)
        return bool(deleted)

    def audio_path(self, audio_id: str) -> Path | None:
        if not is_id(audio_id):
            return None
        row = self._db.query_one("SELECT rel_path FROM audio WHERE id = ?", (audio_id,))
        if row is None:
            return None
        path = self._layout.from_rel(row["rel_path"])
        return path if path.is_file() else None

    def prune(self, preferences: Preferences) -> int:
        """Delete the oldest entries beyond the configured limits; returns how many."""
        rows = self._db.query("SELECT id, total_bytes FROM history ORDER BY created_at, id")
        count = len(rows)
        size = sum(row["total_bytes"] for row in rows)
        doomed = []
        for row in rows:
            if count <= preferences.history_max_entries and size <= preferences.history_max_bytes:
                break
            doomed.append(row["id"])
            count -= 1
            size -= row["total_bytes"]
        for history_id in doomed:
            self.delete(history_id)
        if doomed:
            log.info("pruned %d history entries", len(doomed))
        return len(doomed)

    def _outputs(self, history_ids: list[str]) -> dict[str, list[AudioOutput]]:
        result: dict[str, list[AudioOutput]] = {history_id: [] for history_id in history_ids}
        if not history_ids:
            return result
        marks = ",".join("?" * len(history_ids))
        for row in self._db.query(
            f"SELECT id, history_id, idx, duration_s FROM audio WHERE history_id IN ({marks})"
            " ORDER BY idx",
            history_ids,
        ):
            result[row["history_id"]].append(
                AudioOutput(index=row["idx"], audio_id=row["id"], duration_s=row["duration_s"])
            )
        return result


def _summary(row: Any, outputs: dict[str, list[AudioOutput]]) -> HistorySummary:
    return HistorySummary(
        id=row["id"],
        created_at=row["created_at"],
        model_id=row["model_id"],
        text=row["text"],
        caption=row["caption"],
        reference_kind=row["reference_kind"],
        used_seed=row["used_seed"],
        watermarked=bool(row["watermarked"]),
        outputs=outputs.get(row["id"], []),
    )


def _dump(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
