"""Reference clips: ad-hoc uploads for single generations (`ReferenceInput.kind ==
"clips"`) and the ordered clips a library voice owns (Session 4).

Each clip is stored once as a float32 WAV (`<data-root>/clips/<id>/audio.wav`) with its
encoded reference latents cached next to it, one file per model/codec/normalization
setting, so repeated generations skip the encoder (upstream's "--ref-latents" path).
Edits (trim, split) create new clips and delete the edited one, so a cached latent always
matches its audio.
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
from collections.abc import Callable, Sequence
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import BinaryIO

import numpy as np

from app.audio.io import (
    AudioDecodeError,
    normalize_upload,
    preview_wav,
    read_frames,
    write_float_wav,
)
from app.audio.io import info as audio_info
from app.engine.base import RuntimeOptions, TtsBackend
from app.engine.registry import ModelSpec
from app.errors import ApiError, ErrorCode
from app.schemas import ClipInfo
from app.services.job_manager import now_iso
from app.storage.db import Database
from app.storage.files import DataLayout, is_id, new_id, remove_tree

MAX_UPLOAD_BYTES = 100 * 1024 * 1024
MAX_CLIP_SECONDS = 600.0
MIN_CLIP_SECONDS = 0.1
MAX_VOICE_CLIPS = 32
# Clips no voice owns (ad-hoc uploads, abandoned drafts) are deleted after this long.
UNOWNED_CLIP_TTL = timedelta(days=1)
_CHUNK = 1024 * 1024

# Where a clip's audio came from. Uploaded and recorded audio may be a real person's
# voice and needs consent inside a voice (D13); generated audio does not.
REAL_VOICE_ORIGINS = frozenset({"upload", "recording"})


class ClipStore:
    def __init__(self, db: Database, layout: DataLayout, ffmpeg: Path | None) -> None:
        self._db = db
        self._layout = layout
        self._ffmpeg = ffmpeg

    # --- Creation -----------------------------------------------------------------------

    def add(self, filename: str, stream: BinaryIO, *, origin: str = "upload") -> ClipInfo:
        """Decode an uploaded file of any supported format into a new clip."""
        clip_id = new_id()
        folder = self._layout.clips / clip_id
        folder.mkdir(parents=True, exist_ok=True)
        upload = folder / "upload.bin"
        try:
            digest = _copy_limited(stream, upload, MAX_UPLOAD_BYTES)
            try:
                normalize_upload(upload, folder / "audio.wav", ffmpeg=self._ffmpeg)
            except AudioDecodeError as exc:
                raise ApiError(ErrorCode.parse(exc.code), str(exc), status_code=415) from exc
            upload.unlink(missing_ok=True)
            return self._register(clip_id, filename, origin, digest)
        except BaseException:
            remove_tree(folder)
            raise

    def add_file(self, path: Path, filename: str, *, origin: str) -> ClipInfo:
        """A new clip from an audio file on disk (a generated candidate, a package)."""
        with path.open("rb") as stream:
            return self.add(filename, stream, origin=origin)

    def add_frames(
        self, frames: np.ndarray, sample_rate: int, filename: str, *, origin: str
    ) -> ClipInfo:
        clip_id = new_id()
        folder = self._layout.clips / clip_id
        try:
            write_float_wav(folder / "audio.wav", frames, sample_rate)
            digest = hashlib.sha256(np.ascontiguousarray(frames).tobytes()).hexdigest()
            return self._register(clip_id, filename, origin, digest)
        except BaseException:
            remove_tree(folder)
            raise

    def _register(self, clip_id: str, filename: str, origin: str, digest: str) -> ClipInfo:
        wav = self._layout.clips / clip_id / "audio.wav"
        meta = audio_info(wav)
        if meta.duration_s > MAX_CLIP_SECONDS:
            raise ApiError(
                ErrorCode.CLIP_TOO_LONG,
                "clip is too long",
                status_code=413,
                detail={"max_seconds": MAX_CLIP_SECONDS},
            )
        if meta.duration_s < MIN_CLIP_SECONDS:
            raise ApiError(ErrorCode.CLIP_TOO_SHORT, "clip is too short", status_code=422)
        created_at = now_iso()
        name = filename[:255] or "clip"
        with self._db.transaction() as conn:
            conn.execute(
                "INSERT INTO clips (id, created_at, filename, rel_path, sha256, duration_s,"
                " sample_rate, channels, bytes, origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    clip_id, created_at, name, self._layout.to_rel(wav), digest,
                    meta.duration_s, meta.sample_rate, meta.channels, wav.stat().st_size, origin,
                ),
            )  # fmt: skip
        clip = self.get(clip_id)
        assert clip is not None
        return clip

    # --- Queries ------------------------------------------------------------------------

    def get(self, clip_id: str) -> ClipInfo | None:
        if not is_id(clip_id):
            return None
        row = self._db.query_one("SELECT * FROM clips WHERE id = ?", (clip_id,))
        return None if row is None else _clip(row)

    def for_voice(self, voice_id: str) -> list[ClipInfo]:
        rows = self._db.query(
            "SELECT * FROM clips WHERE voice_id = ? ORDER BY idx, created_at", (voice_id,)
        )
        return [_clip(row) for row in rows]

    def audio_path(self, clip_id: str) -> Path:
        row = self._db.query_one("SELECT rel_path FROM clips WHERE id = ?", (clip_id,))
        if row is None:
            raise ApiError(ErrorCode.CLIP_NOT_FOUND, "clip not found", status_code=404)
        return self._layout.from_rel(row["rel_path"])

    def preview(self, clip_id: str) -> bytes:
        return preview_wav(self.audio_path(clip_id))

    # --- Edits --------------------------------------------------------------------------

    def trim(self, clip_id: str, start_s: float, end_s: float) -> ClipInfo:
        """Keep `start_s`..`end_s`; the result replaces the clip (also inside its voice)."""
        clip = self._require(clip_id)
        frames, rate = read_frames(self.audio_path(clip_id))
        start, end = _bounds(frames, rate, start_s, end_s)
        piece = self.add_frames(frames[start:end], rate, clip.filename, origin=clip.origin)
        self._replace(clip, [piece])
        return self._require(piece.clip_id)

    def split(self, clip_id: str, at_s: Sequence[float]) -> list[ClipInfo]:
        """Cut at each position; the pieces replace the clip (also inside its voice)."""
        clip = self._require(clip_id)
        frames, rate = read_frames(self.audio_path(clip_id))
        cuts = sorted({round(t * rate) for t in at_s})
        if any(cut <= 0 or cut >= len(frames) for cut in cuts):
            raise ApiError(ErrorCode.CLIP_RANGE_INVALID, "split point outside the clip")
        edges = [0, *cuts, len(frames)]
        if any((b - a) / rate < MIN_CLIP_SECONDS for a, b in zip(edges, edges[1:], strict=False)):
            raise ApiError(ErrorCode.CLIP_TOO_SHORT, "a piece would be too short", status_code=422)
        pieces: list[ClipInfo] = []
        try:
            for a, b in zip(edges, edges[1:], strict=False):
                pieces.append(self.add_frames(frames[a:b], rate, clip.filename, origin=clip.origin))
        except BaseException:
            for piece in pieces:
                self.delete(piece.clip_id)
            raise
        self._replace(clip, pieces)
        return [self._require(piece.clip_id) for piece in pieces]

    def _replace(self, old: ClipInfo, new: list[ClipInfo]) -> None:
        if old.voice_id is not None:
            order = [c.clip_id for c in self.for_voice(old.voice_id)]
            index = order.index(old.clip_id)
            order[index : index + 1] = [c.clip_id for c in new]
            with self._db.transaction() as conn:
                conn.execute("UPDATE clips SET voice_id = NULL WHERE id = ?", (old.clip_id,))
                self._assign(conn, old.voice_id, order)
        self.delete(old.clip_id)

    # --- Ownership ----------------------------------------------------------------------

    def check_assignable(self, voice_id: str | None, clip_ids: Sequence[str]) -> list[ClipInfo]:
        """The clips a voice may own: existing, unowned or already this voice's."""
        if len(clip_ids) > MAX_VOICE_CLIPS:
            raise ApiError(ErrorCode.VOICE_INVALID, "too many clips", status_code=422)
        if len(set(clip_ids)) != len(clip_ids):
            raise ApiError(ErrorCode.VOICE_INVALID, "duplicate clip ids", status_code=422)
        clips = []
        for clip_id in clip_ids:
            clip = self.get(clip_id)
            if clip is None:
                raise ApiError(
                    ErrorCode.CLIP_NOT_FOUND,
                    "clip not found",
                    status_code=404,
                    detail={"clip_id": clip_id},
                )
            if clip.voice_id is not None and clip.voice_id != voice_id:
                raise ApiError(
                    ErrorCode.CLIP_IN_USE,
                    "clip belongs to another voice",
                    status_code=409,
                    detail={"clip_id": clip_id},
                )
            clips.append(clip)
        return clips

    def assign(self, voice_id: str, clip_ids: Sequence[str]) -> None:
        """Make `clip_ids` (in order) the voice's clips; clips it no longer lists are
        deleted — a removed recording should not linger (D13)."""
        dropped = [c.clip_id for c in self.for_voice(voice_id) if c.clip_id not in clip_ids]
        with self._db.transaction() as conn:
            self._assign(conn, voice_id, clip_ids)
        for clip_id in dropped:
            self.delete(clip_id)

    @staticmethod
    def _assign(conn: sqlite3.Connection, voice_id: str, clip_ids: Sequence[str]) -> None:
        conn.execute("UPDATE clips SET voice_id = NULL, idx = NULL WHERE voice_id = ?", (voice_id,))
        for index, clip_id in enumerate(clip_ids):
            conn.execute(
                "UPDATE clips SET voice_id = ?, idx = ? WHERE id = ?", (voice_id, index, clip_id)
            )

    def purge_unowned(self, max_age: timedelta = UNOWNED_CLIP_TTL) -> int:
        """Delete clips no voice owns once they are older than `max_age`: uploaded and
        recorded audio outside the library should not linger (D13)."""
        cutoff = datetime.now(timezone.utc) - max_age
        stamp = cutoff.isoformat(timespec="milliseconds").replace("+00:00", "Z")
        rows = self._db.query(
            "SELECT id FROM clips WHERE voice_id IS NULL AND created_at < ?", (stamp,)
        )
        for row in rows:
            self.delete(row["id"])
        return len(rows)

    def delete(self, clip_id: str) -> bool:
        if self.get(clip_id) is None:
            return False
        with self._db.transaction() as conn:
            conn.execute("DELETE FROM clips WHERE id = ?", (clip_id,))
        remove_tree(self._layout.clips / clip_id)
        return True

    # --- Latents ------------------------------------------------------------------------

    def latent_path(self, clip_id: str, key: str) -> Path:
        return self._layout.clips / clip_id / "latents" / f"{key}.pt"

    def latents(
        self,
        clip_ids: Sequence[str],
        *,
        backend: TtsBackend,
        spec: ModelSpec,
        options: RuntimeOptions,
        normalize_db: float | None,
        ensure_max: bool,
        on_log: Callable[[str], None] = lambda _line: None,
        on_encoded: Callable[[int, int], None] = lambda _done, _total: None,
    ) -> tuple[list[Path], int]:
        """Cached latent files for the clips, encoding the missing ones (worker thread).
        Returns the paths and how many clips had to be encoded."""
        max_seconds = spec.capabilities.max_ref_seconds
        key = latent_key(spec, options, normalize_db, ensure_max)
        paths: list[Path] = []
        encoded = 0
        for index, clip_id in enumerate(clip_ids):
            latent = self.latent_path(clip_id, key)
            if not latent.is_file():
                on_log(f"[clips] encoding reference clip {clip_id}")
                backend.encode_reference(
                    self.audio_path(clip_id),
                    latent,
                    normalize_db=normalize_db,
                    ensure_max=ensure_max,
                    max_seconds=max_seconds,
                )
                encoded += 1
            paths.append(latent)
            on_encoded(index + 1, len(clip_ids))
        return paths, encoded

    def _require(self, clip_id: str) -> ClipInfo:
        clip = self.get(clip_id)
        if clip is None:
            raise ApiError(ErrorCode.CLIP_NOT_FOUND, "clip not found", status_code=404)
        return clip


def latent_key(
    spec: ModelSpec,
    options: RuntimeOptions,
    normalize_db: float | None,
    ensure_max: bool,
) -> str:
    """Everything that changes the encoded latent: codec weights, device and precision
    (deterministic encode differs slightly across them), and the preprocessing."""
    material = json.dumps(
        {
            "model": spec.id,
            "codec": f"{spec.codec_repo}@{spec.codec_revision}",
            "device": options.codec_device,
            "precision": options.codec_precision,
            "normalize_db": normalize_db,
            # The codec only honours ensure_max when loudness normalization is off.
            "ensure_max": bool(ensure_max) if normalize_db is None else True,
            "max_seconds": spec.capabilities.max_ref_seconds,
        },
        sort_keys=True,
    )
    return hashlib.sha256(material.encode("utf-8")).hexdigest()[:16]


def _clip(row) -> ClipInfo:  # type: ignore[no-untyped-def]
    return ClipInfo(
        clip_id=row["id"],
        filename=row["filename"],
        duration_s=row["duration_s"],
        sample_rate=row["sample_rate"],
        channels=row["channels"],
        created_at=row["created_at"],
        origin=row["origin"],
        voice_id=row["voice_id"],
    )


def _bounds(frames: np.ndarray, rate: int, start_s: float, end_s: float) -> tuple[int, int]:
    start, end = round(start_s * rate), round(end_s * rate)
    # Tolerate an end a few milliseconds past the last sample (UI rounding).
    if len(frames) < end <= len(frames) + rate // 100:
        end = len(frames)
    if start < 0 or end > len(frames) or end <= start:
        raise ApiError(ErrorCode.CLIP_RANGE_INVALID, "range outside the clip")
    if (end - start) / rate < MIN_CLIP_SECONDS:
        raise ApiError(ErrorCode.CLIP_TOO_SHORT, "clip is too short", status_code=422)
    return start, end


def _copy_limited(stream: BinaryIO, dest: Path, limit: int) -> str:
    digest = hashlib.sha256()
    written = 0
    with dest.open("wb") as out:
        while chunk := stream.read(_CHUNK):
            written += len(chunk)
            if written > limit:
                raise ApiError(
                    ErrorCode.CLIP_TOO_LARGE,
                    "upload is too large",
                    status_code=413,
                    detail={"max_bytes": limit},
                )
            digest.update(chunk)
            out.write(chunk)
    if written == 0:
        raise ApiError(ErrorCode.CLIP_EMPTY, "empty upload", status_code=422)
    return digest.hexdigest()
