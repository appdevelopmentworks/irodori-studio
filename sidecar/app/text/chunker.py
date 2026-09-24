"""Narration chunking (D18): a manuscript becomes chunks the model can say in one
generation — whole sentences packed to about `min_chars`..`max_chars`, never over the
estimated length limit — plus what follows each chunk (the pause kind).

Paragraphs (blank lines) always end a chunk. A sentence that is too long is split at
clause marks (、，；：), and as a last resort by length.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass

from app.text.srt import Cue

SENTENCE_END = frozenset("。．！？!?")
CLOSERS = frozenset("」』）)】〉》〕］]\"'”’")
OPENERS = frozenset("「『（(【〈《〔［[\"'“‘")
_CLAUSE = re.compile(r"(?<=[、，,；;：:])")

Estimate = Callable[[str], float]


@dataclass(frozen=True)
class ChunkDraft:
    text: str
    pause_after: str  # clause | sentence | paragraph | cue
    estimated_seconds: float
    cue: Cue | None = None


@dataclass(frozen=True)
class _Piece:
    text: str
    ends_sentence: bool
    seconds: float


def split_text(
    text: str,
    *,
    min_chars: int,
    max_chars: int,
    max_seconds: float,
    estimate: Estimate,
) -> list[ChunkDraft]:
    packer = _Packer(min_chars, max(min_chars, max_chars), max_seconds, estimate)
    drafts: list[ChunkDraft] = []
    for paragraph in paragraphs(text):
        chunks = packer.pack(paragraph)
        for i, (chunk, ends, seconds) in enumerate(chunks):
            if i == len(chunks) - 1:
                pause = "paragraph"
            else:
                pause = "sentence" if ends else "clause"
            drafts.append(ChunkDraft(chunk, pause, round(seconds, 2)))
    return drafts


def split_cues(cues: list[Cue]) -> list[ChunkDraft]:
    """SRT input: one chunk per cue, to be generated at the cue's length."""
    return [
        ChunkDraft(cue.text, "cue", round((cue.end_ms - cue.start_ms) / 1000, 2), cue)
        for cue in cues
    ]


def paragraphs(text: str) -> list[list[str]]:
    """Paragraphs (split at blank lines) as lists of sentences; a line break also ends a
    sentence."""
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    out: list[list[str]] = []
    for block in re.split(r"\n[ \t\u3000]*\n", text):
        sentences: list[str] = []
        for line in block.split("\n"):
            sentences.extend(sentences_of(line))
        if sentences:
            out.append(sentences)
    return out


def sentences_of(line: str) -> list[str]:
    out: list[str] = []
    start, i, n = 0, 0, len(line)
    while i < n:
        c = line[i]
        ascii_stop = c == "." and (i + 1 == n or line[i + 1].isspace())
        if c in SENTENCE_END or ascii_stop:
            j = i + 1
            while j < n and line[j] in SENTENCE_END:
                j += 1
            closed = j
            while closed < n and line[closed] in CLOSERS:
                closed += 1
            # 「…。」と言った: a closing quote followed by more text continues the sentence.
            if (
                closed > j
                and closed < n
                and not line[closed].isspace()
                and (line[closed] not in OPENERS)
            ):
                i = closed
                continue
            piece = line[start:closed].strip()
            if piece:
                out.append(piece)
            start = i = closed
            continue
        i += 1
    rest = line[start:].strip()
    if rest:
        out.append(rest)
    return out


def join(left: str, right: str) -> str:
    """Japanese joins directly; a space only between two Latin words or sentences."""
    if left and right and left[-1].isascii() and not left[-1].isspace() and right[0].isascii():
        return f"{left} {right}"
    return left + right


class _Packer:
    def __init__(self, min_chars: int, max_chars: int, max_seconds: float, estimate: Estimate):
        self.min_chars = min_chars
        self.max_chars = max_chars
        self.max_seconds = max_seconds
        self.estimate = estimate

    def pack(self, sentences: list[str]) -> list[tuple[str, bool, float]]:
        pieces: list[_Piece] = []
        for sentence in sentences:
            seconds = self.estimate(sentence)
            if self._fits(sentence, seconds):
                pieces.append(_Piece(sentence, True, seconds))
            else:
                pieces.extend(self._split_long(sentence))

        chunks: list[tuple[str, bool, float]] = []
        text, ends, seconds = "", True, 0.0
        for piece in pieces:
            if not text:
                text, ends, seconds = piece.text, piece.ends_sentence, piece.seconds
                continue
            merged = join(text, piece.text)
            # Close a chunk once it is long enough, or when the next piece would not fit.
            if len(text) >= self.min_chars or not self._fits(merged, seconds + piece.seconds):
                chunks.append((text, ends, seconds))
                text, ends, seconds = piece.text, piece.ends_sentence, piece.seconds
            else:
                text, ends, seconds = merged, piece.ends_sentence, seconds + piece.seconds
        if text:
            chunks.append((text, ends, seconds))

        # A very short last chunk ("はい。") goes with the previous one when that fits.
        if len(chunks) >= 2 and len(chunks[-1][0]) < self.min_chars // 2:
            (a, _, sa), (b, ends_b, sb) = chunks[-2], chunks[-1]
            merged = join(a, b)
            if self._fits(merged, sa + sb):
                chunks[-2:] = [(merged, ends_b, sa + sb)]
        return chunks

    def _fits(self, text: str, seconds: float) -> bool:
        return len(text) <= self.max_chars and seconds <= self.max_seconds

    def _split_long(self, sentence: str) -> list[_Piece]:
        parts: list[str] = []
        current = ""
        for clause in (c for c in _CLAUSE.split(sentence) if c):
            if not self._fits(clause, self.estimate(clause)):
                if current:
                    parts.append(current)
                    current = ""
                parts.extend(self._hard_split(clause))
            elif current and not self._fits(current + clause, self.estimate(current + clause)):
                parts.append(current)
                current = clause
            else:
                current += clause
        if current:
            parts.append(current)
        return [
            _Piece(part, i == len(parts) - 1, self.estimate(part)) for i, part in enumerate(parts)
        ]

    def _hard_split(self, text: str) -> list[str]:
        """No clause mark left: cut by length (shorter while the estimate is too long)."""
        out: list[str] = []
        while text:
            size = min(len(text), self.max_chars)
            while size > 1 and self.estimate(text[:size]) > self.max_seconds:
                size = max(1, int(size * 0.85))
            out.append(text[:size])
            text = text[size:]
        return out


def markdown_to_text(markdown: str) -> str:
    """Plain text from Markdown for narration: headings and rules become paragraph
    breaks; list, quote, emphasis, link and code syntax is removed; code blocks, images
    and HTML tags are dropped."""
    out: list[str] = []
    in_code = False
    for raw in markdown.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        line = raw.strip()
        if line.startswith(("```", "~~~")):
            in_code = not in_code
            out.append("")
            continue
        if in_code:
            continue
        if re.fullmatch(r"(-{3,}|\*{3,}|_{3,})", line):
            out.append("")
            continue
        heading = re.fullmatch(r"#{1,6}\s+(.*?)\s*#*", line)
        if heading:
            out.extend(["", heading.group(1), ""])
            continue
        if re.fullmatch(r"\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?", line):
            continue  # table separator row
        line = re.sub(r"^(>\s?)+", "", line)
        line = re.sub(r"^([-*+]|\d+[.)])\s+", "", line)
        line = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", line)
        line = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", line)
        line = re.sub(r"`([^`]*)`", r"\1", line)
        line = re.sub(r"(\*\*|__)(.+?)\1", r"\2", line)
        line = re.sub(r"(?<![\w*])\*(?=\S)(.+?)(?<=\S)\*", r"\1", line)
        line = re.sub(r"<[^>]+>", "", line)
        if line.startswith("|"):
            line = "、".join(cell.strip() for cell in line.strip("|").split("|") if cell.strip())
        out.append(line)
    return "\n".join(out)
