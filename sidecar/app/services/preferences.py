"""Sidecar-side preferences: settings the sidecar applies per request (watermark, history
limits), persisted in the SQLite `preferences` table.

App-shell settings that need a restart (locale, data root, device) stay in Rust's
settings.json (D16); these apply immediately and also govern the external API, which
does not go through the UI (decisions.md, S2).
"""

from __future__ import annotations

import json
import threading

from app.schemas import Preferences, PreferencesPatch
from app.storage.db import Database


class PreferencesStore:
    def __init__(self, db: Database) -> None:
        self._db = db
        self._lock = threading.Lock()
        self._cached: Preferences | None = None

    def get(self) -> Preferences:
        with self._lock:
            if self._cached is None:
                stored = {
                    row["key"]: json.loads(row["value"])
                    for row in self._db.query("SELECT key, value FROM preferences")
                }
                known = {k: v for k, v in stored.items() if k in Preferences.model_fields}
                try:
                    self._cached = Preferences(**known)
                except ValueError:
                    self._cached = Preferences()
            return self._cached

    def update(self, patch: PreferencesPatch) -> Preferences:
        changes = patch.model_dump(exclude_unset=True, exclude_none=True)
        with self._lock:
            with self._db.transaction() as conn:
                for key, value in changes.items():
                    conn.execute(
                        "INSERT INTO preferences (key, value) VALUES (?, ?) "
                        "ON CONFLICT (key) DO UPDATE SET value = excluded.value",
                        (key, json.dumps(value)),
                    )
            self._cached = None
        return self.get()
