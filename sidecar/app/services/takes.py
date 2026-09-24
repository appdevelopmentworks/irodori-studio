"""Takes: generated audio owned by a narration (per chunk index) or a script (per line id),
plus each owner's assembled file. They are rows of `audio` that the history never prunes;
they play and save through `/audio/{id}` like history audio.
"""

from __future__ import annotations

import sqlite3
from collections.abc import Callable
from pathlib import Path
from typing import Any

import numpy as np

from app.audio.io import write_wav
from app.errors import ApiError, ErrorCode
from app.schemas import Take
from app.services.job_manager import now_iso
from app.services.synthesis import Synthesized
from app.storage.db import Database
from app.storage.files import DataLayout, new_id

# A take at least this close to the output limit was probably cut off.
TRUNCATION_SLACK_S = 0.05

Commit = Callable[[sqlite3.Connection, list[Take]], bool]


class TakeStore:
    def __init__(
        self, db: Database, layout: DataLayout, *, owner: str, item: str, root: Path
    ) -> None:
        """`owner` / `item` name the audio columns: ("narration_id", "chunk_idx") or
        ("script_id", "line_id"); files live in `root/<owner id>/`."""
        self._db = db
        self._layout = layout
        self._owner = owner
        self._item = item
        self._root = root

    def by_item(self, owner_id: str) -> dict[Any, list[Take]]:
        takes: dict[Any, list[Take]] = {}
        for row in self._db.query(
            f"SELECT * FROM audio WHERE {self._owner} = ? AND {self._item} IS NOT NULL"
            " ORDER BY created_at, idx",
            (owner_id,),
        ):
            takes.setdefault(row[self._item], []).append(
                Take(
                    audio_id=row["id"],
                    duration_s=row["duration_s"],
                    seed=row["seed"] or 0,
                    truncated=bool(row["truncated"]),
                    created_at=row["created_at"] or "",
                )
            )
        return takes

    def write(
        self,
        owner_id: str,
        item: Any,
        done: Synthesized,
        *,
        limit_s: float | None,
        commit: Commit,
    ) -> list[Take]:
        """Store the candidates of one synthesis as takes of `item`. `commit` runs inside
        the transaction: it records the adoption and says whether the takes are still
        wanted (e.g. the item's text did not change meanwhile); if not, nothing is kept."""
        folder = self._root / owner_id
        created = now_iso()
        takes: list[Take] = []
        rows: list[tuple[Any, ...]] = []
        for index, samples in enumerate(done.audios):
            audio_id = new_id()
            path = folder / f"{audio_id}.wav"
            size = write_wav(path, samples, done.sample_rate)
            duration = round(len(samples) / done.sample_rate, 3)
            truncated = limit_s is not None and duration >= limit_s - TRUNCATION_SLACK_S
            takes.append(
                Take(
                    audio_id=audio_id,
                    duration_s=duration,
                    seed=done.used_seed,
                    truncated=truncated,
                    created_at=created,
                )
            )
            rows.append(
                (audio_id, owner_id, item, index, self._layout.to_rel(path), duration,
                 done.sample_rate, size, done.used_seed, int(truncated), created)
            )  # fmt: skip
        with self._db.transaction() as conn:
            keep = commit(conn, takes)
            if keep:
                conn.executemany(
                    f"INSERT INTO audio (id, {self._owner}, {self._item}, idx, rel_path,"
                    " duration_s, sample_rate, bytes, seed, truncated, created_at)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    rows,
                )
        if not keep:
            for take in takes:
                (folder / f"{take.audio_id}.wav").unlink(missing_ok=True)
            return []
        return takes

    def drop(self, owner_id: str, which: Callable[[Any], bool]) -> int:
        """Delete the takes selected by `which(item)` (never the assembled file)."""
        rows = self._db.query(
            f"SELECT id, rel_path, {self._item} AS item FROM audio"
            f" WHERE {self._owner} = ? AND {self._item} IS NOT NULL",
            (owner_id,),
        )
        doomed = [row for row in rows if which(row["item"])]
        if doomed:
            with self._db.transaction() as conn:
                conn.executemany("DELETE FROM audio WHERE id = ?", [(row["id"],) for row in doomed])
            for row in doomed:
                self._layout.from_rel(row["rel_path"]).unlink(missing_ok=True)
        return len(doomed)

    def write_assembled(self, owner_id: str, audio: np.ndarray, rate: int) -> tuple[str, float]:
        """Replace the owner's assembled file; returns (audio id, duration)."""
        self.drop_assembled(owner_id)
        audio_id = new_id()
        path = self._root / owner_id / f"{audio_id}.wav"
        size = write_wav(path, audio, rate)
        duration = round(len(audio) / rate, 3)
        with self._db.transaction() as conn:
            conn.execute(
                f"INSERT INTO audio (id, {self._owner}, {self._item}, idx, rel_path, duration_s,"
                " sample_rate, bytes, created_at) VALUES (?, ?, NULL, 0, ?, ?, ?, ?, ?)",
                (audio_id, owner_id, self._layout.to_rel(path), duration, rate, size, now_iso()),
            )
        return audio_id, duration

    def drop_assembled(self, owner_id: str) -> None:
        rows = self._db.query(
            f"SELECT id, rel_path FROM audio WHERE {self._owner} = ? AND {self._item} IS NULL",
            (owner_id,),
        )
        if not rows:
            return
        with self._db.transaction() as conn:
            conn.executemany("DELETE FROM audio WHERE id = ?", [(row["id"],) for row in rows])
        for row in rows:
            self._layout.from_rel(row["rel_path"]).unlink(missing_ok=True)

    def path(self, audio_id: str | None) -> Path:
        row = self._db.query_one("SELECT rel_path FROM audio WHERE id = ?", (audio_id or "",))
        if row is None:
            raise ApiError(ErrorCode.AUDIO_NOT_FOUND, "audio not found", status_code=404)
        return self._layout.from_rel(row["rel_path"])
