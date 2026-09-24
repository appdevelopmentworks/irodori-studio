"""Saving generated audio in other formats (D20).

WAV is copied as generated (48 kHz mono 16-bit); MP3, M4A (AAC), FLAC and Opus are
encoded by ffmpeg — the bundled LGPL build in installed apps, the one on PATH in dev
(`IRODORI_FFMPEG`, set by Rust). This is the plain-conversion part of Session 7's
`POST /export`, which adds sample rate, loudness, tempo and gain.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Literal

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
    "mp3": (("-c:a", "libmp3lame", "-q:a", "2"), "mp3"),  # VBR, ~190 kbps
    "m4a": (("-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"), "ipod"),
    "flac": (("-c:a", "flac"), "flac"),
    "opus": (("-c:a", "libopus", "-b:a", "128k"), "opus"),
}


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


def export_audio(source: Path, dest: Path, fmt: str, *, ffmpeg: Path | None) -> None:
    """Write `source` (a generated WAV) to `dest` in `fmt`, replacing `dest` atomically."""
    partial = dest.with_name(f".{dest.name}.part")
    try:
        if fmt == "wav":
            shutil.copyfile(source, partial)
        else:
            _encode(source, partial, fmt, ffmpeg)
        os.replace(partial, dest)
    except OSError as exc:
        raise ExportError("save_failed", str(exc)) from exc
    finally:
        partial.unlink(missing_ok=True)


def _encode(source: Path, dest: Path, fmt: str, ffmpeg: Path | None) -> None:
    if ffmpeg is None or not ffmpeg.is_file():
        raise ExportError("ffmpeg_unavailable", "this format needs ffmpeg")
    options, muxer = _ENCODERS[fmt]
    command = [
        str(ffmpeg), "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
        "-i", str(source), "-vn", *options, "-f", muxer, str(dest),
    ]  # fmt: skip
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if sys.platform == "win32" else 0
    try:
        result = subprocess.run(
            command, capture_output=True, timeout=300, creationflags=flags, check=False
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise ExportError("save_failed", str(exc)) from exc
    if result.returncode != 0:
        message = result.stderr.decode("utf-8", errors="replace").strip()[-500:]
        raise ExportError("save_failed", message or "ffmpeg failed")
