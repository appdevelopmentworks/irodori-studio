"""Scripts (requirements §6.7): dialogue pasted as text ("話者：セリフ", "話者: セリフ",
"話者「セリフ」") or read from a CSV / TSV table with a header row, and written back to
a table for game engines. Reading a table this module wrote returns the same lines.
"""

from __future__ import annotations

import csv
import io
import re
from dataclasses import dataclass

_BOM = chr(0xFEFF)
MAX_SPEAKER_CHARS = 32

# "話者：セリフ" / "話者: セリフ"; a speaker has no colon, quote or bracket in it.
_COLON_LINE = re.compile(
    r"^(?P<speaker>[^：:「」『』（）()\s][^：:「」『』（）()]*?)\s*[：:]\s*(?P<text>\S.*)$"
)
# "話者「セリフ」"
_QUOTE_LINE = re.compile(
    r"^(?P<speaker>[^：:「」『』（）()\s][^：:「」『』（）()]*?)\s*[「『](?P<text>.*)[」』]$"
)
# "（ト書き）": stage directions are not spoken.
_DIRECTION = re.compile(r"^[（(].*[）)]$")

# Table columns and the header names that map to them (case and spaces ignored).
COLUMNS: dict[str, tuple[str, ...]] = {
    "index": ("index", "no", "no.", "#", "番号", "行"),
    "speaker": ("speaker", "character", "name", "話者", "キャラクター", "キャラ", "名前"),
    "text": ("text", "line", "dialogue", "serif", "セリフ", "台詞", "せりふ", "本文", "テキスト"),
    "caption": ("caption", "style", "キャプション", "スタイル"),
    "candidates": ("candidates", "num_candidates", "候補数"),
    "seed": ("seed", "シード"),
    "pause_ms": ("pause_ms", "pause", "pause after", "間", "行後の間"),
    "file": ("file", "file_name", "filename", "ファイル名", "ファイル"),
}
TABLE_HEADER = ["index", "speaker", "text", "caption", "candidates", "seed", "pause_ms", "file"]


class ScriptError(ValueError):
    """`reason`: "empty" (no lines), "header" (no text column), "value" (a bad number),
    with `detail` saying where."""

    def __init__(self, reason: str, **detail: object) -> None:
        super().__init__(reason)
        self.reason = reason
        self.detail = detail


@dataclass(frozen=True)
class LineDraft:
    speaker: str
    text: str
    caption: str | None = None
    num_candidates: int | None = None
    seed: int | None = None
    pause_ms: int | None = None
    file_name: str | None = None


def parse_text(text: str) -> list[LineDraft]:
    """One line per non-empty text line. A line without a speaker continues the previous
    speaker; lines wholly in parentheses are stage directions and skipped."""
    lines: list[LineDraft] = []
    speaker = ""
    for raw in text.lstrip(_BOM).replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        line = raw.strip().strip(chr(0x3000))
        if not line or _DIRECTION.match(line):
            continue
        match = _COLON_LINE.match(line) or _QUOTE_LINE.match(line)
        if match and len(match["speaker"].strip()) <= MAX_SPEAKER_CHARS:
            speaker = match["speaker"].strip()
            body = _unquote(match["text"].strip())
        else:
            body = _unquote(line)
        if body:
            lines.append(LineDraft(speaker=speaker, text=body))
    if not lines:
        raise ScriptError("empty")
    return lines


def parse_table(text: str, delimiter: str | None = None) -> list[LineDraft]:
    """A CSV / TSV table with a header row (see `COLUMNS`); a table without a recognized
    header is read as speaker, text columns."""
    text = text.lstrip(_BOM)
    if delimiter is None:
        first = text.split("\n", 1)[0]
        delimiter = "\t" if first.count("\t") >= first.count(",") and "\t" in first else ","
    rows = [row for row in csv.reader(io.StringIO(text), delimiter=delimiter) if any(row)]
    if not rows:
        raise ScriptError("empty")
    columns = _columns(rows[0])
    if "text" in columns:
        body = rows[1:]
    elif len(rows[0]) >= 2 and not any(_normalize(cell) in _KNOWN for cell in rows[0]):
        columns, body = {"speaker": 0, "text": 1}, rows
    else:
        raise ScriptError("header")

    lines: list[LineDraft] = []
    for number, row in enumerate(body, start=2 if body is not rows else 1):

        def cell(name: str, row: list[str] = row) -> str:
            index = columns.get(name)
            return row[index].strip() if index is not None and index < len(row) else ""

        text_value = cell("text")
        if not text_value:
            continue
        lines.append(
            LineDraft(
                speaker=cell("speaker")[:MAX_SPEAKER_CHARS],
                text=text_value,
                caption=cell("caption") or None,
                num_candidates=_number(cell("candidates"), number, "candidates"),
                seed=_number(cell("seed"), number, "seed"),
                pause_ms=_number(cell("pause_ms"), number, "pause_ms"),
                file_name=cell("file") or None,
            )
        )
    if not lines:
        raise ScriptError("empty")
    return lines


def to_table(lines: list[LineDraft], delimiter: str = ",") -> str:
    """The lines as a table `parse_table` reads back unchanged (header row, 1-based index)."""
    buffer = io.StringIO()
    writer = csv.writer(buffer, delimiter=delimiter, lineterminator="\r\n")
    writer.writerow(TABLE_HEADER)
    for index, line in enumerate(lines, start=1):
        writer.writerow(
            [
                index,
                line.speaker,
                line.text,
                line.caption or "",
                "" if line.num_candidates is None else line.num_candidates,
                "" if line.seed is None else line.seed,
                "" if line.pause_ms is None else line.pause_ms,
                line.file_name or "",
            ]
        )
    return buffer.getvalue()


def _normalize(name: str) -> str:
    return "".join(name.lstrip(_BOM).split()).lower()


_KNOWN = {_normalize(alias) for aliases in COLUMNS.values() for alias in aliases}


def _columns(header: list[str]) -> dict[str, int]:
    found: dict[str, int] = {}
    for index, name in enumerate(header):
        key = _normalize(name)
        for column, aliases in COLUMNS.items():
            if column not in found and key in {_normalize(a) for a in aliases}:
                found[column] = index
    return found


def _number(value: str, row: int, column: str) -> int | None:
    if not value:
        return None
    try:
        number = int(value)
    except ValueError as exc:
        raise ScriptError("value", row=row, column=column) from exc
    if number < 0:
        raise ScriptError("value", row=row, column=column)
    return number


def _unquote(text: str) -> str:
    """「セリフ」 → セリフ (only when the quotes wrap the whole line)."""
    for opener, closer in (("「", "」"), ("『", "』"), ('"', '"'), ("“", "”")):
        if len(text) >= 2 and text.startswith(opener) and text.endswith(closer):
            inner = text[1:-1]
            if opener not in inner:
                return inner.strip()
    return text
