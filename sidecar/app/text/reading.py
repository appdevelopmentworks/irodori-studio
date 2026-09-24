"""Reading preview and length estimates (D19, D18).

pyopenjtalk-plus (OpenJTalk with its dictionary in the wheel; Sudachi resolves
heteronyms) estimates katakana readings and mora counts. Readings are a hint only: the
model reads the text itself and may say something else. Until the analyzer is installed
(an older runtime), tokens are the plain text and lengths are estimated from characters.
"""

from __future__ import annotations

import logging
import threading
import unicodedata
from dataclasses import dataclass
from types import ModuleType
from typing import Literal

log = logging.getLogger("irodori.text")

# Measured on v4.1-Small output (decisions.md, S5): articulation of about 6-8 morae per
# second, plus a pause of about 1.5 s at every sentence end. Slow voices run up to ~3 s
# over this on a long chunk, which the chunker's margin absorbs.
MORAE_PER_SECOND = 7.0
CHARS_PER_SECOND = 6.0  # without the analyzer
SENTENCE_PAUSE_S = 1.5
CLAUSE_PAUSE_S = 0.25

SENTENCE_MARKS = frozenset("。．！？!?")
CLAUSE_MARKS = frozenset("、，,；;：:")


@dataclass(frozen=True)
class Token:
    surface: str
    reading: str
    moras: int
    kind: Literal["analyzer", "symbol", "text"]


class Reader:
    def __init__(self) -> None:
        # OpenJTalk keeps global state: one call at a time.
        self._lock = threading.Lock()
        self._module: ModuleType | None = None
        self._failed = False

    @property
    def available(self) -> bool:
        with self._lock:
            return self._load() is not None

    def _load(self) -> ModuleType | None:
        if self._module is None and not self._failed:
            try:
                import pyopenjtalk  # noqa: PLC0415 - heavy; loaded on first use

                self._module = pyopenjtalk
            except Exception:  # not installed, or a broken wheel
                log.warning("reading analyzer unavailable", exc_info=True)
                self._failed = True
        return self._module

    def tokens(self, text: str) -> list[Token]:
        with self._lock:
            module = self._load()
            if module is None:
                return [Token(text, text, 0, "text")] if text.strip() else []
            out: list[Token] = []
            for line in text.splitlines():
                if not line.strip():
                    continue
                for feature in module.run_frontend(line):
                    # OpenJTalk widens ASCII; show it as written.
                    surface = unicodedata.normalize("NFKC", str(feature["string"]))
                    moras = int(feature.get("mora_size") or 0)
                    if feature.get("pos") == "記号" or moras <= 0:
                        out.append(Token(surface, surface, 0, "symbol"))
                        continue
                    reading = str(feature.get("read") or "")
                    if reading in ("", "*"):
                        reading = str(feature.get("pron") or surface).replace("’", "")
                    out.append(Token(surface, reading, moras, "analyzer"))
            return out

    def moras(self, text: str) -> int | None:
        """Mora count, or None without the analyzer."""
        if not self.available:
            return None
        return sum(token.moras for token in self.tokens(text))

    def estimate_seconds(self, text: str) -> float:
        """Rough length of `text` when spoken (the text after the user dictionary)."""
        moras = self.moras(text)
        spoken = (
            moras / MORAE_PER_SECOND
            if moras is not None
            else sum(1 for c in text if not c.isspace()) / CHARS_PER_SECOND
        )
        # Every piece ends in a pause, even a line without a full stop (a title).
        sentences = max(1, sum(1 for c in text if c in SENTENCE_MARKS)) if text.strip() else 0
        clauses = sum(1 for c in text if c in CLAUSE_MARKS)
        return round(spoken + sentences * SENTENCE_PAUSE_S + clauses * CLAUSE_PAUSE_S, 2)
