"""Ad-hoc reference clips (`ReferenceInput.kind == "clips"`): uploads for a single
generation, as opposed to library voices (Session 4).

Each clip is stored once as a float32 WAV (`<data-root>/clips/<id>/audio.wav`) with its
encoded reference latents cached next to it, one file per model/codec/normalization
setting, so repeated generations skip the encoder (upstream's "--ref-latents" path).
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Callable
from pathlib import Path
from typing import BinaryIO

from app.audio.io import AudioDecodeError, normalize_upload
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
_CHUNK = 1024 * 1024


class ClipStore:
    def __init__(self, db: Database, layout: DataLayout, ffmpeg: Path | None) -> None:
        self._db = db
        self._layout = layout
        self._ffmpeg = ffmpeg

    def add(self, filename: str, stream: BinaryIO) -> ClipInfo:
        clip_id = new_id()
        folder = self._layout.clips / clip_id
        folder.mkdir(parents=True, exist_ok=True)
        upload = folder / "upload.bin"
        try:
            digest = _copy_limited(stream, upload, MAX_UPLOAD_BYTES)
            try:
                info = normalize_upload(upload, folder / "audio.wav", ffmpeg=self._ffmpeg)
            except AudioDecodeError as exc:
                raise ApiError(ErrorCode.parse(exc.code), str(exc), status_code=415) from exc
            if info.duration_s > MAX_CLIP_SECONDS:
                raise ApiError(
                    ErrorCode.CLIP_TOO_LONG,
                    "clip is too long",
                    status_code=413,
                    detail={"max_seconds": MAX_CLIP_SECONDS},
                )
            if info.duration_s < MIN_CLIP_SECONDS:
                raise ApiError(ErrorCode.CLIP_TOO_SHORT, "clip is too short", status_code=422)
        except BaseException:
            remove_tree(folder)
            raise
        upload.unlink(missing_ok=True)
        wav = folder / "audio.wav"
        created_at = now_iso()
        with self._db.transaction() as conn:
            conn.execute(
                "INSERT INTO clips (id, created_at, filename, rel_path, sha256, duration_s,"
                " sample_rate, channels, bytes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    clip_id, created_at, filename[:255], self._layout.to_rel(wav), digest,
                    info.duration_s, info.sample_rate, info.channels, wav.stat().st_size,
                ),
            )  # fmt: skip
        return ClipInfo(
            clip_id=clip_id,
            filename=filename[:255],
            duration_s=info.duration_s,
            sample_rate=info.sample_rate,
            channels=info.channels,
            created_at=created_at,
        )

    def get(self, clip_id: str) -> ClipInfo | None:
        if not is_id(clip_id):
            return None
        row = self._db.query_one("SELECT * FROM clips WHERE id = ?", (clip_id,))
        if row is None:
            return None
        return ClipInfo(
            clip_id=row["id"],
            filename=row["filename"],
            duration_s=row["duration_s"],
            sample_rate=row["sample_rate"],
            channels=row["channels"],
            created_at=row["created_at"],
        )

    def audio_path(self, clip_id: str) -> Path:
        row = self._db.query_one("SELECT rel_path FROM clips WHERE id = ?", (clip_id,))
        if row is None:
            raise ApiError(ErrorCode.CLIP_NOT_FOUND, "clip not found", status_code=404)
        return self._layout.from_rel(row["rel_path"])

    def delete(self, clip_id: str) -> bool:
        if self.get(clip_id) is None:
            return False
        with self._db.transaction() as conn:
            conn.execute("DELETE FROM clips WHERE id = ?", (clip_id,))
        remove_tree(self._layout.clips / clip_id)
        return True

    def latents(
        self,
        clip_ids: tuple[str, ...],
        *,
        backend: TtsBackend,
        spec: ModelSpec,
        options: RuntimeOptions,
        normalize_db: float | None,
        ensure_max: bool,
        on_log: Callable[[str], None] = lambda _line: None,
    ) -> list[Path]:
        """Cached latent files for the clips, encoding the missing ones (worker thread)."""
        max_seconds = spec.capabilities.max_ref_seconds
        key = _latent_key(spec, options, normalize_db, ensure_max, max_seconds)
        paths: list[Path] = []
        for clip_id in clip_ids:
            latent = self._layout.clips / clip_id / "latents" / f"{key}.pt"
            if not latent.is_file():
                on_log(f"[clips] encoding reference clip {clip_id}")
                backend.encode_reference(
                    self.audio_path(clip_id),
                    latent,
                    normalize_db=normalize_db,
                    ensure_max=ensure_max,
                    max_seconds=max_seconds,
                )
            paths.append(latent)
        return paths


def _latent_key(
    spec: ModelSpec,
    options: RuntimeOptions,
    normalize_db: float | None,
    ensure_max: bool,
    max_seconds: float,
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
            "max_seconds": max_seconds,
        },
        sort_keys=True,
    )
    return hashlib.sha256(material.encode("utf-8")).hexdigest()[:16]


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
