"""SQLite metadata store `<data-root>/irodori-studio.db` (D16), owned by the sidecar.

One connection shared by all threads behind a lock: the app writes a handful of rows
per generation, so simplicity beats concurrency here. Audio lives in files; rows store
paths relative to the data root. Schema versions are tracked with `PRAGMA user_version`;
append migrations, never edit a shipped one.
"""

from __future__ import annotations

import sqlite3
import threading
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from pathlib import Path
from typing import Any

MIGRATIONS: tuple[str, ...] = (
    # 1 — Session 2: preferences, generation history with its audio, ad-hoc reference clips.
    """
    CREATE TABLE preferences (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL              -- JSON
    );
    CREATE TABLE history (
        id             TEXT PRIMARY KEY, -- ULID
        created_at     TEXT NOT NULL,    -- ISO 8601 UTC
        kind           TEXT NOT NULL,    -- 'tts'
        model_id       TEXT NOT NULL,
        text           TEXT NOT NULL,
        caption        TEXT,
        reference_kind TEXT NOT NULL,
        request_json   TEXT NOT NULL,    -- the SynthesisRequest as submitted
        params_json    TEXT NOT NULL,    -- every resolved parameter actually used
        used_seed      INTEGER NOT NULL,
        timings_json   TEXT NOT NULL,
        messages_json  TEXT NOT NULL,
        watermarked    INTEGER NOT NULL,
        device         TEXT NOT NULL,
        precision      TEXT NOT NULL,
        total_bytes    INTEGER NOT NULL
    );
    CREATE INDEX history_created_at ON history (created_at);
    CREATE TABLE audio (
        id          TEXT PRIMARY KEY,    -- ULID
        history_id  TEXT NOT NULL REFERENCES history (id) ON DELETE CASCADE,
        idx         INTEGER NOT NULL,
        rel_path    TEXT NOT NULL,
        duration_s  REAL NOT NULL,
        sample_rate INTEGER NOT NULL,
        bytes       INTEGER NOT NULL
    );
    CREATE INDEX audio_history ON audio (history_id);
    CREATE TABLE clips (
        id            TEXT PRIMARY KEY,  -- ULID
        created_at    TEXT NOT NULL,
        filename      TEXT NOT NULL,     -- original upload name (display only)
        rel_path      TEXT NOT NULL,
        sha256        TEXT NOT NULL,
        duration_s    REAL NOT NULL,
        sample_rate   INTEGER NOT NULL,
        channels      INTEGER NOT NULL,
        bytes         INTEGER NOT NULL
    );
    """,
    # 2 — Session 3: the candidate the user adopted.
    """
    ALTER TABLE history ADD COLUMN adopted_audio_id TEXT;
    """,
    # 3 — Session 4: the voice library. Clips stay in `clips` (one audio file + cached
    # latents each); a voice owns an ordered set of them.
    """
    CREATE TABLE voices (
        id                  TEXT PRIMARY KEY,  -- ULID
        name                TEXT NOT NULL,
        source              TEXT NOT NULL,     -- designed | imported | recorded | embedding
        created_at          TEXT NOT NULL,
        updated_at          TEXT NOT NULL,
        model_id            TEXT NOT NULL,     -- the model the voice was made with
        caption_default     TEXT,
        params_default_json TEXT NOT NULL,     -- SamplingParams overrides (JSON object)
        seed_default        INTEGER,
        lora_path           TEXT,
        test_text           TEXT,
        design_caption      TEXT,              -- the caption a designed voice came from
        embedding_rel_path  TEXT,              -- `.speaker.safetensors` (embedding voices)
        consent_json        TEXT               -- D13: {confirmed_at, statement, locale, version}
    );
    ALTER TABLE clips ADD COLUMN voice_id TEXT;
    ALTER TABLE clips ADD COLUMN idx INTEGER;
    ALTER TABLE clips ADD COLUMN origin TEXT NOT NULL DEFAULT 'upload';
    CREATE INDEX clips_voice ON clips (voice_id, idx);
    """,
)


class Database:
    def __init__(self, path: Path) -> None:
        self.path = path
        self._lock = threading.RLock()
        self._conn: sqlite3.Connection | None = None

    def _connection(self) -> sqlite3.Connection:
        # Opened lazily so creating the app (e.g. in tests) never touches the disk.
        if self._conn is None:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            conn = sqlite3.connect(self.path, check_same_thread=False, isolation_level=None)
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA foreign_keys = ON")
            conn.execute("PRAGMA journal_mode = WAL")
            conn.execute("PRAGMA synchronous = NORMAL")
            _migrate(conn)
            self._conn = conn
        return self._conn

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        with self._lock:
            conn = self._connection()
            conn.execute("BEGIN IMMEDIATE")
            try:
                yield conn
            except BaseException:
                conn.execute("ROLLBACK")
                raise
            conn.execute("COMMIT")

    def query(self, sql: str, params: Sequence[Any] = ()) -> list[sqlite3.Row]:
        with self._lock:
            return list(self._connection().execute(sql, params))

    def query_one(self, sql: str, params: Sequence[Any] = ()) -> sqlite3.Row | None:
        rows = self.query(sql, params)
        return rows[0] if rows else None

    def close(self) -> None:
        with self._lock:
            if self._conn is not None:
                self._conn.close()
                self._conn = None


def _migrate(conn: sqlite3.Connection) -> None:
    version = conn.execute("PRAGMA user_version").fetchone()[0]
    if version > len(MIGRATIONS):
        raise RuntimeError(
            f"database schema {version} is newer than this app supports ({len(MIGRATIONS)})"
        )
    for number, script in enumerate(MIGRATIONS[version:], start=version + 1):
        conn.executescript(f"BEGIN;\n{script}\nPRAGMA user_version = {number};\nCOMMIT;")
