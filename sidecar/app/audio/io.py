"""Audio file I/O without torch: decoding uploads and writing generated WAVs (48 kHz).

Uploads are normalized to a float32 WAV so upstream sees exactly the samples it would
decode itself. soundfile (libsndfile 1.2) reads WAV/FLAC/OGG/Opus/MP3; anything else
(m4a, webm from the recorder, ...) goes through the bundled ffmpeg when it is staged.
"""

from __future__ import annotations

import io
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import soundfile as sf


class AudioDecodeError(Exception):
    """The file is not audio we can read; `code` is a stable error code."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class AudioInfo:
    duration_s: float
    sample_rate: int
    channels: int
    frames: int


def info(path: Path) -> AudioInfo:
    meta = sf.info(str(path))
    return AudioInfo(
        duration_s=float(meta.frames) / float(meta.samplerate) if meta.samplerate else 0.0,
        sample_rate=int(meta.samplerate),
        channels=int(meta.channels),
        frames=int(meta.frames),
    )


def normalize_upload(src: Path, dest: Path, *, ffmpeg: Path | None) -> AudioInfo:
    """Decode `src` into a float32 WAV at `dest`, keeping rate and channels."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    try:
        data, sample_rate = sf.read(str(src), dtype="float32", always_2d=True)
    except (sf.LibsndfileError, RuntimeError, ValueError):
        if ffmpeg is None:
            raise AudioDecodeError("clip_format_unsupported", "format needs ffmpeg") from None
        _ffmpeg_to_wav(ffmpeg, src, dest)
    else:
        sf.write(str(dest), data, sample_rate, subtype="FLOAT", format="WAV")
    result = info(dest)
    if result.frames == 0:
        dest.unlink(missing_ok=True)
        raise AudioDecodeError("clip_empty", "no audio samples")
    return result


def read_frames(path: Path) -> tuple[np.ndarray, int]:
    """Decode to float32 `(frames, channels)`."""
    data, sample_rate = sf.read(str(path), dtype="float32", always_2d=True)
    return data, int(sample_rate)


def write_float_wav(path: Path, frames: np.ndarray, sample_rate: int) -> AudioInfo:
    """Store reference audio losslessly as a float32 WAV (the canonical clip format)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    partial = path.with_name(path.name + ".part")
    sf.write(str(partial), frames, sample_rate, subtype="FLOAT", format="WAV")
    partial.replace(path)
    return info(path)


def preview_wav(path: Path) -> bytes:
    """16-bit PCM copy for playback and waveforms in the WebView."""
    frames, sample_rate = read_frames(path)
    buffer = io.BytesIO()
    sf.write(buffer, np.clip(frames, -1.0, 1.0), sample_rate, subtype="PCM_16", format="WAV")
    return buffer.getvalue()


def write_wav(path: Path, samples: np.ndarray, sample_rate: int) -> int:
    """Write mono 16-bit PCM; returns the file size. Samples are clipped to [-1, 1]."""
    path.parent.mkdir(parents=True, exist_ok=True)
    clipped = np.clip(np.asarray(samples, dtype=np.float32).reshape(-1), -1.0, 1.0)
    partial = path.with_name(path.name + ".part")
    sf.write(str(partial), clipped, sample_rate, subtype="PCM_16", format="WAV")
    partial.replace(path)
    return path.stat().st_size


def _ffmpeg_to_wav(ffmpeg: Path, src: Path, dest: Path) -> None:
    command = [
        str(ffmpeg), "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
        "-i", str(src), "-vn", "-c:a", "pcm_f32le", "-f", "wav", str(dest),
    ]  # fmt: skip
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if sys.platform == "win32" else 0
    try:
        result = subprocess.run(
            command, capture_output=True, timeout=300, creationflags=flags, check=False
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise AudioDecodeError("clip_decode_failed", str(exc)) from exc
    if result.returncode != 0 or not dest.is_file():
        dest.unlink(missing_ok=True)
        message = result.stderr.decode("utf-8", errors="replace").strip()[-500:]
        raise AudioDecodeError("clip_decode_failed", message or "ffmpeg failed")
