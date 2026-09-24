"""Subtitles: SRT or WebVTT as narration input (one chunk per cue, requirements §6.6) and
SRT / WebVTT output built from the assembled audio."""

from __future__ import annotations

import re
from dataclasses import dataclass

_STAMP = r"(?:\d+:)?\d{1,2}:\d{2}[,.]\d{1,3}"
_TIMING = re.compile(rf"^\s*({_STAMP})\s*-->\s*({_STAMP})")
_TAGS = re.compile(r"<[^>]*>|\{\\[^}]*\}")  # <i>, <v Name>, <c.x>, {\an8}


class SubtitleError(ValueError):
    """The input has no usable cues."""


@dataclass(frozen=True)
class Cue:
    start_ms: int
    end_ms: int
    text: str


def looks_like_subtitles(text: str) -> bool:
    return any(_TIMING.match(line) for line in text.splitlines()[:50])


def parse(text: str) -> list[Cue]:
    """Cues of an SRT or WebVTT document, in file order. Styling tags are dropped and
    a cue's lines are joined into one."""
    text = text.lstrip("\ufeff").replace("\r\n", "\n").replace("\r", "\n")
    cues: list[Cue] = []
    for block in re.split(r"\n[ \t]*\n", text.strip()):
        lines = block.split("\n")
        for i, line in enumerate(lines):
            match = _TIMING.match(line)
            if match is None:
                continue
            start, end = _ms(match.group(1)), _ms(match.group(2))
            body = [_TAGS.sub("", part).strip() for part in lines[i + 1 :]]
            joined = _join([part for part in body if part])
            if joined and end > start:
                cues.append(Cue(start, end, joined))
            break
    if not cues:
        raise SubtitleError("no cues found")
    return cues


def to_srt(cues: list[Cue]) -> str:
    return "".join(
        f"{n}\n{_stamp(c.start_ms, ',')} --> {_stamp(c.end_ms, ',')}\n{c.text}\n\n"
        for n, c in enumerate(cues, start=1)
    )


def to_vtt(cues: list[Cue]) -> str:
    body = "".join(
        f"{n}\n{_stamp(c.start_ms, '.')} --> {_stamp(c.end_ms, '.')}\n{c.text}\n\n"
        for n, c in enumerate(cues, start=1)
    )
    return "WEBVTT\n\n" + body


def _ms(stamp: str) -> int:
    clock, _, fraction = stamp.replace(",", ".").partition(".")
    parts = [int(p) for p in clock.split(":")]
    hours, minutes, seconds = ([0] * (3 - len(parts)) + parts)[-3:]
    millis = int(fraction.ljust(3, "0")[:3])
    return ((hours * 60 + minutes) * 60 + seconds) * 1000 + millis


def _stamp(ms: int, separator: str) -> str:
    ms = max(0, int(ms))
    hours, rest = divmod(ms, 3_600_000)
    minutes, rest = divmod(rest, 60_000)
    seconds, millis = divmod(rest, 1000)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}{separator}{millis:03d}"


def _join(lines: list[str]) -> str:
    """Japanese lines join directly; a space only between two Latin words."""
    out = ""
    for line in lines:
        if out and out[-1].isascii() and out[-1].isalnum() and line[0].isascii():
            out += " "
        out += line
    return out
