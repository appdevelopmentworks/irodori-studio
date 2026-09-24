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
    # 4 — Session 5: the user dictionary and narrations. `audio` is rebuilt so a row can
    # belong to a narration (chunk takes, the assembled file) instead of a history entry:
    # history pruning never touches narration audio.
    """
    CREATE TABLE dictionary (
        id         TEXT PRIMARY KEY,         -- ULID
        position   INTEGER NOT NULL,
        surface    TEXT NOT NULL,
        reading    TEXT NOT NULL,
        enabled    INTEGER NOT NULL,
        note       TEXT,
        updated_at TEXT NOT NULL
    );
    CREATE TABLE narrations (
        id             TEXT PRIMARY KEY,     -- ULID
        title          TEXT NOT NULL,
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL,
        format         TEXT NOT NULL,        -- text | markdown | srt
        source         TEXT NOT NULL,        -- the manuscript as given
        rules_json     TEXT NOT NULL,
        settings_json  TEXT NOT NULL,
        warnings_json  TEXT NOT NULL,
        assembled_json TEXT,                 -- {audio_id, duration_s, cues}
        lock_json      TEXT                  -- voice lock source {audio_id, clip_id}
    );
    CREATE TABLE narration_chunks (
        narration_id      TEXT NOT NULL REFERENCES narrations (id) ON DELETE CASCADE,
        idx               INTEGER NOT NULL,
        text              TEXT NOT NULL,
        pause_after       TEXT NOT NULL,     -- clause | sentence | paragraph | cue
        estimated_seconds REAL NOT NULL,
        cue_start_ms      INTEGER,
        cue_end_ms        INTEGER,
        adopted_audio_id  TEXT,
        PRIMARY KEY (narration_id, idx)
    );
    CREATE TABLE audio_new (
        id           TEXT PRIMARY KEY,       -- ULID
        history_id   TEXT REFERENCES history (id) ON DELETE CASCADE,
        narration_id TEXT REFERENCES narrations (id) ON DELETE CASCADE,
        chunk_idx    INTEGER,                -- a narration take's chunk (NULL: assembled)
        idx          INTEGER NOT NULL,
        rel_path     TEXT NOT NULL,
        duration_s   REAL NOT NULL,
        sample_rate  INTEGER NOT NULL,
        bytes        INTEGER NOT NULL,
        seed         INTEGER,
        truncated    INTEGER NOT NULL DEFAULT 0,
        created_at   TEXT
    );
    INSERT INTO audio_new (id, history_id, idx, rel_path, duration_s, sample_rate, bytes)
        SELECT id, history_id, idx, rel_path, duration_s, sample_rate, bytes FROM audio;
    DROP TABLE audio;
    ALTER TABLE audio_new RENAME TO audio;
    CREATE INDEX audio_history ON audio (history_id);
    CREATE INDEX audio_narration ON audio (narration_id, chunk_idx);
    """,
    # 5 — Session 6: scripts (dialogue). Lines have stable ids, so their takes survive
    # inserting, deleting and reordering lines.
    """
    CREATE TABLE scripts (
        id             TEXT PRIMARY KEY,     -- ULID
        title          TEXT NOT NULL,
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL,
        speakers_json  TEXT NOT NULL,        -- [{name, voice_id, caption}] in order
        settings_json  TEXT NOT NULL,
        assembled_json TEXT                  -- {audio_id, duration_s, cues}
    );
    CREATE TABLE script_lines (
        id               TEXT PRIMARY KEY,   -- ULID
        script_id        TEXT NOT NULL REFERENCES scripts (id) ON DELETE CASCADE,
        position         INTEGER NOT NULL,
        speaker          TEXT NOT NULL,
        text             TEXT NOT NULL,
        caption          TEXT,
        num_candidates   INTEGER,
        seed             INTEGER,
        pause_ms         INTEGER,
        file_name        TEXT,
        adopted_audio_id TEXT
    );
    CREATE INDEX script_lines_order ON script_lines (script_id, position);
    ALTER TABLE audio ADD COLUMN script_id TEXT REFERENCES scripts (id) ON DELETE CASCADE;
    ALTER TABLE audio ADD COLUMN line_id TEXT;
    CREATE INDEX audio_script ON audio (script_id, line_id);
    """,
    # 6 — Session 7: the library voice of a history entry (filtering by voice) and
    # parameter presets.
    """
    ALTER TABLE history ADD COLUMN voice_id TEXT;
    UPDATE history SET voice_id = json_extract(request_json, '$.reference.voice_id')
        WHERE json_extract(request_json, '$.reference.kind') = 'voice';
    CREATE INDEX history_voice ON history (voice_id, created_at);
    CREATE TABLE presets (
        id          TEXT PRIMARY KEY,        -- ULID
        name        TEXT NOT NULL,
        params_json TEXT NOT NULL,           -- SamplingParams: the values given
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
    );
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
