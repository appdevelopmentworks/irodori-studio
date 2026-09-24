"""File names from templates such as "{index}_{speaker}_{text_head}" (script lines,
library exports), made safe for Windows and macOS and unique within one export."""

from __future__ import annotations

import re

MAX_NAME_CHARS = 120
TEXT_HEAD_CHARS = 12

_TOKEN = re.compile(r"\{(\w*)\}")
# Characters no file name may contain on Windows or macOS (and control characters).
_UNSAFE = re.compile("[" + re.escape('<>:"/|?*' + chr(92)) + chr(0) + "-" + chr(31) + "]")


class TemplateError(ValueError):
    """A field the template may not use."""

    def __init__(self, token: str) -> None:
        super().__init__(f"unknown template field: {token}")
        self.token = token


def check(template: str, tokens: frozenset[str]) -> None:
    for token in _TOKEN.findall(template):
        if token not in tokens:
            raise TemplateError(token)


def fill(template: str, values: dict[str, str]) -> str:
    """The template with its {fields} filled in (unknown fields stay as written)."""
    return _TOKEN.sub(lambda m: values.get(m.group(1), m.group(0)), template)


def safe(name: str) -> str:
    cleaned = " ".join(_UNSAFE.sub("_", name).split())
    return cleaned.strip(" .")[:MAX_NAME_CHARS]


def zero_padded(n: int, count: int) -> str:
    """`n` padded to the digits of `count`, at least three ("007")."""
    return str(n).zfill(max(3, len(str(count))))


class UniqueNames:
    """Names made unique case-insensitively by appending "_2", "_3", …"""

    def __init__(self) -> None:
        self._taken: set[str] = set()

    def take(self, name: str) -> str:
        unique, n = name, 2
        while unique.lower() in self._taken:
            unique, n = f"{name}_{n}", n + 1
        self._taken.add(unique.lower())
        return unique
