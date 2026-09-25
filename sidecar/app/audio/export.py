"""Saving generated audio in other formats (D20).

WAV is copied as generated (48 kHz mono 16-bit) unless post-processing changes it; MP3,
M4A (AAC), FLAC and Opus — and any post-processing (`post.py`: sample rate, loudness,
tempo, gain) — go through ffmpeg: the bundled LGPL build in installed apps, the one on
PATH in dev (`IRODORI_FFMPEG`, set by Rust).
"""

from __future__ import annotations

import os
import shutil
from collections.abc import Sequence
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Literal

from app.audio import post as post_processing
from app.audio.post import Post

AudioFormat = Literal["wav", "mp3", "m4a", "flac", "opus"]

EXTENSIONS: dict[str, str] = {
    "wav": ".wav",
    "mp3": ".mp3",
    "m4a": ".m4a",
    "flac": ".flac",
    "opus": ".opus",
}

# (ffmpeg codec options, muxer). The muxer is explicit because the temporary file does
# not end in the real extension.
_ENCODERS: dict[str, tuple[tuple[str, ...], str]] = {
    "wav": (("-c:a", "pcm_s16le"), "wav"),
    "mp3": (("-c:a", "libmp3lame", "-q:a", "2"), "mp3"),  # VBR, ~190 kbps
    "m4a": (("-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"), "ipod"),
    "flac": (("-c:a", "flac"), "flac"),
    "opus": (("-c:a", "libopus", "-b:a", "128k"), "opus"),
    # For the external API only (D21): raw AAC in ADTS.
    "aac": (("-c:a", "aac", "-b:a", "192k"), "adts"),
}

# Files exported at once (one ffmpeg process each).
PARALLEL_EXPORTS = 4


class ExportError(Exception):
    """`code` is a stable error code (app/errors.py)."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def format_of(path: Path) -> str | None:
    """The format a file name asks for, from its extension."""
    suffix = path.suffix.lower()
    return next((fmt for fmt, ext in EXTENSIONS.items() if ext == suffix), None)


def destination(path: Path, fmt: str) -> Path:
    """`path` with the format's extension (replacing another audio extension)."""
    ext = EXTENSIONS[fmt]
    if path.suffix.lower() == ext:
        return path
    if format_of(path) is not None:
        return path.with_suffix(ext)
    return path.with_name(path.name + ext)


def export_audio(
    source: Path, dest: Path, fmt: str, *, ffmpeg: Path | None, post: Post | None = None
) -> None:
    """Write `source` (a generated WAV) to `dest` in `fmt` with `post` applied, replacing
    `dest` atomically."""
    partial = dest.with_name(f".{dest.name}.part")
    try:
        if fmt == "wav" and (post is None or post.identity):
            shutil.copyfile(source, partial)
        else:
            _encode(source, partial, fmt, ffmpeg, post or Post())
        os.replace(partial, dest)
    except OSError as exc:
        raise ExportError("save_failed", str(exc)) from exc
    except post_processing.PostError as exc:
        raise ExportError(exc.code, str(exc)) from exc
    finally:
        partial.unlink(missing_ok=True)


def export_many(
    pairs: Sequence[tuple[Path, Path]], fmt: str, *, ffmpeg: Path | None, post: Post | None
) -> None:
    """`export_audio` for many (source, dest) pairs, a few ffmpeg processes at a time."""
    if fmt == "wav" and (post is None or post.identity):
        workers = 1  # plain copies
    else:
        workers = min(PARALLEL_EXPORTS, max(1, len(pairs)))
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [
            pool.submit(export_audio, source, dest, fmt, ffmpeg=ffmpeg, post=post)
            for source, dest in pairs
        ]
        for future in futures:
            future.result()  # the first failure is raised


def _encode(source: Path, dest: Path, fmt: str, ffmpeg: Path | None, post: Post) -> None:
    if ffmpeg is None or not ffmpeg.is_file():
        raise ExportError("ffmpeg_unavailable", "this format needs ffmpeg")
    options, muxer = _ENCODERS[fmt]
    chain = post_processing.filter_chain(ffmpeg, source, post)
    args = ["-i", str(source), "-vn"]
    if chain:
        args += ["-af", ",".join(chain)]
    args += ["-ar", str(post.output_rate(fmt)), *options, "-f", muxer, str(dest)]
    post_processing.run(ffmpeg, args)
