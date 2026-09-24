"""Post-processing for exports (D20): sample rate, loudness, tempo and gain, applied by
ffmpeg while encoding.

Loudness is two-pass EBU R128 (`loudnorm`): the file is measured first, then normalized
linearly to the target where the true-peak ceiling allows it (ffmpeg switches to its
dynamic mode otherwise). Tempo is a time stretch (`atempo`) that keeps the pitch; gain
is a plain volume change and only applies when loudness is off.
"""

from __future__ import annotations

import json
import math
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

NATIVE_RATE = 48_000  # the model's output rate
TRUE_PEAK_DB = -1.0  # ceiling for normalized output
# A loose loudness range keeps speech in loudnorm's linear mode (no dynamic compression).
LOUDNESS_RANGE = 20.0
TIMEOUT_S = 600


class PostError(Exception):
    """`code` is a stable error code (app/errors.py)."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class Post:
    sample_rate: int = NATIVE_RATE
    loudness: float | None = None  # target LUFS (integrated)
    tempo: float = 1.0
    gain_db: float = 0.0

    @property
    def identity(self) -> bool:
        """Nothing to change: a WAV can be copied as it is."""
        return (
            self.sample_rate == NATIVE_RATE
            and self.loudness is None
            and self.tempo == 1.0
            and self.gain_db == 0.0
        )

    def output_rate(self, fmt: str) -> int:
        # Opus is always 48 kHz (the encoder has no 44.1 kHz mode).
        return NATIVE_RATE if fmt == "opus" else self.sample_rate


def post_of(options: object | None) -> Post | None:
    """A `Post` from the API's PostOptions (or None for no post-processing)."""
    if options is None:
        return None
    return Post(
        sample_rate=int(getattr(options, "sample_rate", NATIVE_RATE)),
        loudness=getattr(options, "loudness", None),
        tempo=float(getattr(options, "tempo", 1.0)),
        gain_db=float(getattr(options, "gain_db", 0.0)),
    )


def retimed(ms: int, post: Post | None) -> int:
    """Where a moment of the audio lands after the tempo change (subtitle cues)."""
    return ms if post is None or post.tempo == 1.0 else round(ms / post.tempo)


def filter_chain(ffmpeg: Path, source: Path, post: Post) -> list[str]:
    """The `-af` filters for `post` (measuring the source first for loudness)."""
    chain: list[str] = []
    if post.tempo != 1.0:
        chain.append(f"atempo={post.tempo:.4f}")
    if post.loudness is not None:
        measured = measure(ffmpeg, source, post.loudness, chain)
        if measured is not None:  # silence cannot be normalized
            chain.append(
                _loudnorm(post.loudness)
                + f":measured_I={measured['input_i']:.2f}"
                + f":measured_TP={measured['input_tp']:.2f}"
                + f":measured_LRA={measured['input_lra']:.2f}"
                + f":measured_thresh={measured['input_thresh']:.2f}"
                + f":offset={measured['target_offset']:.2f}"
                + ":linear=true:print_format=none"
            )
    elif post.gain_db != 0.0:
        chain.append(f"volume={post.gain_db:.2f}dB")
    return chain


def measure(
    ffmpeg: Path, source: Path, target: float, pre: list[str] | None = None
) -> dict[str, float] | None:
    """loudnorm's first pass over `source` (after `pre` filters); None for silence."""
    chain = ",".join([*(pre or []), _loudnorm(target) + ":print_format=json"])
    stderr = run(ffmpeg, ["-i", str(source), "-af", chain, "-f", "null", "-"], verbose=True)
    blocks = re.findall(r"\{[^{}]*\}", stderr)
    if not blocks:
        raise PostError("save_failed", "loudness measurement failed")
    data = json.loads(blocks[-1])
    keys = ("input_i", "input_tp", "input_lra", "input_thresh", "target_offset")
    try:
        values = {key: float(data[key]) for key in keys}
    except (KeyError, ValueError) as exc:
        raise PostError("save_failed", "loudness measurement failed") from exc
    return values if all(math.isfinite(v) for v in values.values()) else None


def integrated_loudness(ffmpeg: Path, path: Path) -> float:
    """Integrated loudness (LUFS) of a file, e.g. to check an export."""
    measured = measure(ffmpeg, path, -23.0)
    return -math.inf if measured is None else measured["input_i"]


def run(ffmpeg: Path | None, args: list[str], *, verbose: bool = False) -> str:
    """Run ffmpeg; returns its stderr (the log)."""
    if ffmpeg is None or not ffmpeg.is_file():
        raise PostError("ffmpeg_unavailable", "this export needs ffmpeg")
    command = [
        str(ffmpeg), "-nostdin", "-hide_banner", "-nostats",
        "-loglevel", "info" if verbose else "error", "-y", *args,
    ]  # fmt: skip
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if sys.platform == "win32" else 0
    try:
        result = subprocess.run(
            command, capture_output=True, timeout=TIMEOUT_S, creationflags=flags, check=False
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise PostError("save_failed", str(exc)) from exc
    stderr = result.stderr.decode("utf-8", errors="replace")
    if result.returncode != 0:
        raise PostError("save_failed", stderr.strip()[-500:] or "ffmpeg failed")
    return stderr


def _loudnorm(target: float) -> str:
    return f"loudnorm=I={target:.1f}:TP={TRUE_PEAK_DB:.1f}:LRA={LOUDNESS_RANGE:.1f}"
