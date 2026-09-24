"""User dictionary (D19): surface → reading replacements applied to the text before it
reaches upstream, which then applies its own normalization (NFKC and a few symbol
rules). At each position the longest surface wins and matches never overlap. Surfaces
match regardless of character width ("AI" also matches "ＡＩ"), since upstream folds
width anyway.
"""

from __future__ import annotations

import re
import threading
import unicodedata
from dataclasses import dataclass

from app.errors import ApiError, ErrorCode
from app.schemas import DictionaryEntry, DictionaryEntryInput
from app.services.job_manager import now_iso
from app.storage.db import Database
from app.storage.files import new_id

MAX_ENTRIES = 5000


@dataclass(frozen=True)
class Segment:
    """A piece of the rewritten text: plain text, or a dictionary replacement."""

    text: str
    entry: DictionaryEntry | None = None


@dataclass(frozen=True)
class Applied:
    text: str
    replacements: int
    segments: tuple[Segment, ...]


def _fullwidth(text: str) -> str:
    """ASCII letters, digits and symbols as their full-width forms."""
    return "".join(chr(ord(c) + 0xFEE0) if "!" <= c <= "~" else c for c in text)


def _variants(surface: str) -> set[str]:
    folded = unicodedata.normalize("NFKC", surface)
    return {surface, folded, _fullwidth(folded)}


class DictionaryStore:
    def __init__(self, db: Database) -> None:
        self._db = db
        self._lock = threading.Lock()
        self._matcher: tuple[re.Pattern[str], dict[str, DictionaryEntry]] | None = None

    def list(self) -> list[DictionaryEntry]:
        rows = self._db.query("SELECT * FROM dictionary ORDER BY position")
        return [_entry(row) for row in rows]

    def replace(self, entries: list[DictionaryEntryInput]) -> list[DictionaryEntry]:
        """Replace the whole dictionary (the editor saves its table at once)."""
        if len(entries) > MAX_ENTRIES:
            raise _invalid("too_many", index=MAX_ENTRIES)
        seen: dict[str, int] = {}
        cleaned: list[DictionaryEntryInput] = []
        for index, entry in enumerate(entries):
            surface, reading = entry.surface.strip(), entry.reading.strip()
            if not surface or any(c in surface for c in "\r\n"):
                raise _invalid("surface", index=index)
            if not reading or any(c in reading for c in "\r\n"):
                raise _invalid("reading", index=index)
            key = unicodedata.normalize("NFKC", surface)
            if entry.enabled and key in seen:
                raise _invalid("duplicate", index=index, other=seen[key])
            if entry.enabled:
                seen[key] = index
            note = (entry.note or "").strip() or None
            cleaned.append(
                DictionaryEntryInput(
                    surface=surface, reading=reading, enabled=entry.enabled, note=note
                )
            )
        now = now_iso()
        with self._db.transaction() as conn:
            conn.execute("DELETE FROM dictionary")
            conn.executemany(
                "INSERT INTO dictionary (id, position, surface, reading, enabled, note,"
                " updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                [
                    (new_id(), position, e.surface, e.reading, int(e.enabled), e.note, now)
                    for position, e in enumerate(cleaned)
                ],
            )
        with self._lock:
            self._matcher = None
        return self.list()

    def apply(self, text: str) -> Applied:
        matcher = self._compiled()
        if matcher is None:
            return Applied(text=text, replacements=0, segments=(Segment(text),) if text else ())
        pattern, by_surface = matcher
        segments: list[Segment] = []
        out: list[str] = []
        position = 0
        count = 0
        for match in pattern.finditer(text):
            if match.start() > position:
                segments.append(Segment(text[position : match.start()]))
            entry = by_surface[match.group(0)]
            segments.append(Segment(entry.reading, entry))
            out.append(text[position : match.start()])
            out.append(entry.reading)
            position = match.end()
            count += 1
        if position < len(text):
            segments.append(Segment(text[position:]))
        out.append(text[position:])
        return Applied(text="".join(out), replacements=count, segments=tuple(segments))

    def _compiled(self) -> tuple[re.Pattern[str], dict[str, DictionaryEntry]] | None:
        with self._lock:
            if self._matcher is not None:
                return self._matcher if self._matcher[1] else None
            by_surface: dict[str, DictionaryEntry] = {}
            for entry in self.list():
                if not entry.enabled:
                    continue
                for variant in _variants(entry.surface):
                    by_surface.setdefault(variant, entry)
            # Longest first: the regex takes the first alternative that matches.
            alternatives = sorted(by_surface, key=len, reverse=True)
            pattern = re.compile("|".join(re.escape(s) for s in alternatives) or "(?!)")
            self._matcher = (pattern, by_surface)
            return self._matcher if by_surface else None


def _entry(row) -> DictionaryEntry:  # type: ignore[no-untyped-def]
    return DictionaryEntry(
        id=row["id"],
        surface=row["surface"],
        reading=row["reading"],
        enabled=bool(row["enabled"]),
        note=row["note"],
    )


def _invalid(reason: str, **detail: object) -> ApiError:
    return ApiError(
        ErrorCode.DICTIONARY_INVALID,
        f"dictionary entry is invalid: {reason}",
        status_code=422,
        detail={"reason": reason, **detail},
    )
