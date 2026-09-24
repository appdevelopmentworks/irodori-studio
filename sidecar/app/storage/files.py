"""File layout under the data root (D16) and small file helpers.

The database stores paths relative to the data root (`to_rel` / `from_rel`), so the
whole folder can be moved ("Move data root", D16).
"""

from __future__ import annotations

import os
import secrets
import shutil
import time
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

_CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"


def new_id() -> str:
    """A ULID: 48-bit millisecond timestamp + 80 random bits, Crockford base32 (sortable)."""
    value = (int(time.time() * 1000) << 80) | secrets.randbits(80)
    chars = []
    for _ in range(26):
        chars.append(_CROCKFORD[value & 31])
        value >>= 5
    return "".join(reversed(chars))


def is_id(value: str) -> bool:
    return len(value) == 26 and all(c in _CROCKFORD for c in value)


@dataclass(frozen=True)
class DataLayout:
    root: Path

    @property
    def database(self) -> Path:
        return self.root / "irodori-studio.db"

    @property
    def history(self) -> Path:
        return self.root / "history"

    @property
    def clips(self) -> Path:
        """Ad-hoc reference clips uploaded for single generations (not library voices)."""
        return self.root / "clips"

    @property
    def tmp(self) -> Path:
        return self.root / "runtime" / "tmp"

    def to_rel(self, path: Path) -> str:
        return path.relative_to(self.root).as_posix()

    def from_rel(self, rel: str) -> Path:
        parts = PurePosixPath(rel).parts
        if not parts or any(part in ("", ".", "..") for part in parts) or rel.startswith("/"):
            raise ValueError(f"unsafe relative path: {rel!r}")
        return self.root.joinpath(*parts)


def remove_tree(path: Path) -> None:
    shutil.rmtree(path, ignore_errors=True)


def file_size(path: Path) -> int:
    try:
        return os.stat(path).st_size
    except OSError:
        return 0
