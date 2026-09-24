"""Joining narration takes (D18): trim each take's leading and trailing silence, then
place the takes on one timeline with pauses (text) or at their cue times (SRT)."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

SILENCE_DB = -50.0  # below this a 10 ms window counts as silence
KEEP_HEAD_MS = 30  # silence kept before the first sound (soft onsets)
KEEP_TAIL_MS = 60  # and after the last (breaths, decays)


@dataclass(frozen=True)
class Placed:
    start: int  # sample offset in the assembled audio
    length: int


def trim_silence(samples: np.ndarray, rate: int) -> np.ndarray:
    """`samples` without leading and trailing silence (a silent take stays as it is)."""
    window = max(1, rate // 100)
    usable = len(samples) // window * window
    if usable == 0:
        return samples
    frames = samples[:usable].reshape(-1, window).astype(np.float64)
    rms = np.sqrt(np.mean(frames * frames, axis=1))
    loud = np.flatnonzero(rms > 10 ** (SILENCE_DB / 20))
    if loud.size == 0:
        return samples
    start = max(0, loud[0] * window - rate * KEEP_HEAD_MS // 1000)
    end = min(len(samples), (loud[-1] + 1) * window + rate * KEEP_TAIL_MS // 1000)
    return samples[start:end]


def join(
    takes: list[np.ndarray],
    rate: int,
    *,
    gaps_ms: list[int] | None = None,
    starts_ms: list[int | None] | None = None,
) -> tuple[np.ndarray, list[Placed]]:
    """Concatenate `takes`. `gaps_ms[i]` is the silence after take i (text mode);
    `starts_ms[i]` places take i at that time instead, or right after the previous take
    when that one runs long (SRT mode)."""
    pieces: list[np.ndarray] = []
    placed: list[Placed] = []
    position = 0
    for i, take in enumerate(takes):
        wanted = starts_ms[i] if starts_ms is not None else None
        if wanted is not None:
            start = max(position, round(wanted * rate / 1000))
            if start > position:
                pieces.append(np.zeros(start - position, dtype=np.float32))
            position = start
        placed.append(Placed(position, len(take)))
        pieces.append(take.astype(np.float32, copy=False))
        position += len(take)
        gap = gaps_ms[i] if gaps_ms is not None and i < len(takes) - 1 else 0
        if gap > 0:
            silence = round(gap * rate / 1000)
            pieces.append(np.zeros(silence, dtype=np.float32))
            position += silence
    audio = np.concatenate(pieces) if pieces else np.zeros(0, dtype=np.float32)
    return audio, placed
