"""Narration (requirements §6.6, D18): a manuscript split into chunks, rendered one after
another on the synthesis queue (D24), then joined with pauses into one file with
subtitles.

Chunks keep all their takes — audio rows owned by the narration, never pruned with the
history — and adopt one. A render job synthesizes the chunks that need it in order; it
can be cancelled and resumed. Editing a chunk's text discards its takes. Without speaker
audio, "voice lock" makes chunk 1's adopted take the reference for the other chunks.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from app.audio import assemble, export
from app.audio.io import read_frames
from app.audio.post import Post, post_of, retimed
from app.engine.base import BackendError, SynthesisCancelled
from app.engine.host import EngineHost
from app.errors import ApiError, ErrorCode, job_failure_code, save_error_code
from app.schemas import (
    AssembledNarration,
    ChunkPatch,
    Cue,
    ExportedFile,
    Narration,
    NarrationChunk,
    NarrationCreate,
    NarrationExported,
    NarrationExportRequest,
    NarrationPatch,
    NarrationSettings,
    NarrationSplit,
    NarrationSummary,
    NarrationWarning,
    ReferenceClips,
    RenderRequest,
    SamplingParams,
    SplitRules,
    SubtitleCue,
    SynthesisRequest,
    Take,
)
from app.services.clips import ClipStore
from app.services.job_manager import Job, JobManager, now_iso
from app.services.queue import SynthesisQueue
from app.services.synthesis import RunHooks, SynthesisService, Synthesized
from app.services.takes import TakeAudio, TakeStore
from app.services.voices import VoiceService
from app.storage.db import Database
from app.storage.files import DataLayout, is_id, new_id, remove_tree
from app.text import srt
from app.text.chunker import ChunkDraft, markdown_to_text, split_cues, split_text
from app.text.dictionary import DictionaryStore
from app.text.reading import Reader

log = logging.getLogger("irodori.narration")

MAX_CHUNKS = 2000
# Chunks are packed to stay under this share of the model's output limit (estimates err).
LENGTH_MARGIN = 0.8
CLAUSE_PAUSE_SHARE = 0.5  # a chunk split mid-sentence pauses half a sentence pause


@dataclass(frozen=True)
class RenderPayload:
    narration_id: str
    indices: tuple[int, ...]
    num_candidates: int | None


@dataclass(frozen=True)
class RestoredChunk:
    """A chunk as a project file saved it, with its adopted take."""

    draft: ChunkDraft
    take: TakeAudio | None


class NarrationService:
    def __init__(
        self,
        *,
        db: Database,
        layout: DataLayout,
        host: EngineHost,
        synthesis: SynthesisService,
        clips: ClipStore,
        voices: VoiceService,
        dictionary: DictionaryStore,
        reader: Reader,
        jobs: JobManager,
        queue: SynthesisQueue,
        ffmpeg: Path | None,
    ) -> None:
        self._db = db
        self._layout = layout
        self._host = host
        self._synthesis = synthesis
        self._clips = clips
        self._voices = voices
        self._dictionary = dictionary
        self._reader = reader
        self._jobs = jobs
        self._queue = queue
        self._ffmpeg = ffmpeg
        self._takes = TakeStore(
            db, layout, owner="narration_id", item="chunk_idx", root=layout.narrations
        )
        self._active: dict[str, str] = {}  # narration id -> its render job

    # --- Queries --------------------------------------------------------------------------

    def list(self) -> list[NarrationSummary]:
        rows = self._db.query(
            "SELECT n.*,"
            " (SELECT COUNT(*) FROM narration_chunks c WHERE c.narration_id = n.id) AS chunks,"
            " (SELECT COUNT(*) FROM narration_chunks c WHERE c.narration_id = n.id"
            "   AND c.adopted_audio_id IS NOT NULL) AS rendered"
            " FROM narrations n ORDER BY n.updated_at DESC, n.id DESC"
        )
        return [
            NarrationSummary(
                id=row["id"],
                title=row["title"],
                created_at=row["created_at"],
                updated_at=row["updated_at"],
                format=row["format"],
                chunks=row["chunks"],
                rendered=row["rendered"],
            )
            for row in rows
        ]

    def get(self, narration_id: str) -> Narration | None:
        if not is_id(narration_id):
            return None
        row = self._db.query_one("SELECT * FROM narrations WHERE id = ?", (narration_id,))
        return None if row is None else self._narration(row)

    def require(self, narration_id: str) -> Narration:
        narration = self.get(narration_id)
        if narration is None:
            raise ApiError(ErrorCode.NARRATION_NOT_FOUND, "narration not found", status_code=404)
        return narration

    def busy(self, narration_id: str) -> bool:
        job_id = self._active.get(narration_id)
        job = self._jobs.get(job_id) if job_id else None
        return job is not None and not job.finished

    # --- Create and edit ------------------------------------------------------------------

    def create(self, body: NarrationCreate) -> Narration:
        drafts, warnings = self._drafts(body.source, body.format, body.rules, body.settings)
        narration_id = new_id()
        now = now_iso()
        title = (body.title or "").strip() or _title_from(drafts)
        with self._db.transaction() as conn:
            conn.execute(
                "INSERT INTO narrations (id, title, created_at, updated_at, format, source,"
                " rules_json, settings_json, warnings_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    narration_id, title, now, now, body.format, body.source,
                    _dump(body.rules.model_dump()), _dump(_settings_dump(body.settings)),
                    _dump([w.model_dump() for w in warnings]),
                ),
            )  # fmt: skip
            _insert_chunks(conn, narration_id, drafts)
        return self.require(narration_id)

    def restore(
        self,
        *,
        title: str,
        fmt: str,
        source: str,
        rules: SplitRules,
        settings: NarrationSettings,
        warnings: list[NarrationWarning],
        chunks: list[RestoredChunk],
    ) -> Narration:
        """A narration as a project file saved it: its chunks as they were (not split
        again) and their adopted takes."""
        narration_id = new_id()
        now = now_iso()
        with self._db.transaction() as conn:
            conn.execute(
                "INSERT INTO narrations (id, title, created_at, updated_at, format, source,"
                " rules_json, settings_json, warnings_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    narration_id, title, now, now, fmt, source, _dump(rules.model_dump()),
                    _dump(_settings_dump(settings)), _dump([w.model_dump() for w in warnings]),
                ),
            )  # fmt: skip
            _insert_chunks(conn, narration_id, [chunk.draft for chunk in chunks])
        for index, chunk in enumerate(chunks):
            if chunk.take is None:
                continue
            audio_id = self._takes.restore(narration_id, index, chunk.take)
            with self._db.transaction() as conn:
                conn.execute(
                    "UPDATE narration_chunks SET adopted_audio_id = ?"
                    " WHERE narration_id = ? AND idx = ?",
                    (audio_id, narration_id, index),
                )
        return self.require(narration_id)

    def resplit(self, narration_id: str, body: NarrationSplit) -> Narration:
        narration = self.require(narration_id)
        self._ensure_idle(narration_id)
        drafts, warnings = self._drafts(body.source, body.format, body.rules, narration.settings)
        with self._db.transaction() as conn:
            conn.execute("DELETE FROM narration_chunks WHERE narration_id = ?", (narration_id,))
            _insert_chunks(conn, narration_id, drafts)
            conn.execute(
                "UPDATE narrations SET format = ?, source = ?, rules_json = ?, warnings_json = ?,"
                " updated_at = ? WHERE id = ?",
                (
                    body.format, body.source, _dump(body.rules.model_dump()),
                    _dump([w.model_dump() for w in warnings]), now_iso(), narration_id,
                ),
            )  # fmt: skip
        self._drop_audio(narration_id, lambda item: True)
        self._drop_lock(narration_id)
        return self.require(narration_id)

    def update(self, narration_id: str, body: NarrationPatch) -> Narration:
        self.require(narration_id)
        columns: dict[str, Any] = {}
        if "title" in body.model_fields_set and body.title:
            columns["title"] = body.title.strip()
        if "settings" in body.model_fields_set and body.settings is not None:
            self._validate_settings(body.settings)
            columns["settings_json"] = _dump(_settings_dump(body.settings))
        if columns:
            columns["updated_at"] = now_iso()
            assignments = ", ".join(f"{column} = ?" for column in columns)
            with self._db.transaction() as conn:
                conn.execute(
                    f"UPDATE narrations SET {assignments} WHERE id = ?",
                    [*columns.values(), narration_id],
                )
            if "settings_json" in columns:
                self._drop_assembled(narration_id)  # pauses may have changed
        return self.require(narration_id)

    def update_chunk(self, narration_id: str, index: int, body: ChunkPatch) -> Narration:
        narration = self.require(narration_id)
        chunk = _chunk(narration, index)
        changes = body.model_fields_set
        if "text" in changes and body.text is not None and body.text.strip() != chunk.text:
            text = body.text.strip()
            seconds = (
                chunk.estimated_seconds
                if chunk.cue is not None
                else self._estimate(text, narration.settings.apply_dictionary)
            )
            with self._db.transaction() as conn:
                conn.execute(
                    "UPDATE narration_chunks SET text = ?, estimated_seconds = ?,"
                    " adopted_audio_id = NULL WHERE narration_id = ? AND idx = ?",
                    (text, seconds, narration_id, index),
                )
            # A take of other words is useless; a running render drops its result too.
            self._drop_audio(narration_id, lambda item: item == index)
        elif "adopted_audio_id" in changes:
            audio_id = body.adopted_audio_id
            if audio_id is not None and audio_id not in {t.audio_id for t in chunk.takes}:
                raise ApiError(
                    ErrorCode.AUDIO_NOT_FOUND, "not a take of this chunk", status_code=404
                )
            with self._db.transaction() as conn:
                conn.execute(
                    "UPDATE narration_chunks SET adopted_audio_id = ?"
                    " WHERE narration_id = ? AND idx = ?",
                    (audio_id, narration_id, index),
                )
        self._touch(narration_id)
        self._drop_assembled(narration_id)
        return self.require(narration_id)

    def delete(self, narration_id: str) -> bool:
        if self.get(narration_id) is None:
            return False
        self._ensure_idle(narration_id)
        self._drop_lock(narration_id)
        with self._db.transaction() as conn:
            # Chunks and audio rows go with it (ON DELETE CASCADE).
            conn.execute("DELETE FROM narrations WHERE id = ?", (narration_id,))
        remove_tree(self._layout.narrations / narration_id)
        return True

    # --- Rendering ------------------------------------------------------------------------

    def enqueue_render(self, narration_id: str, body: RenderRequest) -> Job | None:
        narration = self.require(narration_id)
        self._ensure_idle(narration_id)
        if body.indices is None:
            wanted = [c.index for c in narration.chunks if body.redo or not c.adopted_audio_id]
        else:
            for index in body.indices:
                _chunk(narration, index)
            wanted = sorted(set(body.indices))
            if not body.redo:
                wanted = [i for i in wanted if not narration.chunks[i].adopted_audio_id]
        if not wanted:
            return None
        # Fail now, not in the worker: consent, LoRA, parameters, the reference itself.
        self._synthesis.prepare(self._request(narration, narration.chunks[wanted[0]]))
        job = self._jobs.create(
            "narration", "ui", RenderPayload(narration_id, tuple(wanted), body.num_candidates)
        )
        self._active[narration_id] = job.id
        self._queue.submit(job)
        return job

    def execute_render(self, job: Job) -> None:
        payload: RenderPayload = job.payload
        if job.cancel_requested.is_set():
            job.mark_cancelled()
            return
        job.mark_started()
        rendered = 0
        try:
            narration = self.require(payload.narration_id)
            order = list(payload.indices)
            lock = self._lock_applies(narration.settings)
            if lock and order[0] != 0 and not narration.chunks[0].adopted_audio_id:
                order.insert(0, 0)  # the lock needs chunk 1 first
            for n, index in enumerate(order):
                if job.cancel_requested.is_set():
                    job.mark_cancelled()
                    return
                narration = self.require(payload.narration_id)
                if index >= len(narration.chunks):
                    continue
                chunk = narration.chunks[index]
                reference = None
                if lock and index > 0:
                    reference = ReferenceClips(kind="clips", clip_ids=[self._lock_clip(narration)])
                prepared = self._synthesis.prepare(
                    self._request(narration, chunk, reference, payload.num_candidates)
                )

                def on_log(line: str) -> None:
                    log.info("[%s] %s", job.id, line)
                    job.emit("log", line=line)

                done = self._synthesis.synthesize(
                    prepared,
                    RunHooks(
                        on_log=on_log,
                        on_progress=lambda d, t: job.emit("progress", done=d, total=t, unit="step"),
                        is_cancelled=job.cancel_requested.is_set,
                    ),
                )
                if done is None:
                    job.mark_cancelled()
                    return
                takes = self._store_takes(narration.id, chunk, done)
                if takes:
                    rendered += 1
                    job.emit(
                        "chunk",
                        index=index,
                        takes=[take.model_dump() for take in takes],
                        adopted_audio_id=takes[0].audio_id,
                    )
                job.emit("progress", done=n + 1, total=len(order), unit="chunk")
        except SynthesisCancelled:
            job.mark_cancelled()
            return
        except BackendError as exc:
            log.warning("narration job %s failed: %s %s", job.id, exc.code, exc.message)
            job.mark_failed(ErrorCode.parse(exc.code).value, exc.message)
            return
        except ApiError as exc:
            job.mark_failed(exc.code.value, exc.message)
            return
        except Exception as exc:
            log.exception("narration job %s failed", job.id)
            job.mark_failed(job_failure_code(exc).value, f"{type(exc).__name__}: {exc}")
            return
        job.mark_completed({"narration_id": payload.narration_id, "rendered": rendered})

    # --- Assemble and export --------------------------------------------------------------

    def assemble(self, narration_id: str) -> AssembledNarration:
        narration = self.require(narration_id)
        missing = [c.index for c in narration.chunks if not c.adopted_audio_id]
        if missing:
            raise ApiError(
                ErrorCode.NARRATION_INCOMPLETE,
                "some chunks have no take",
                status_code=409,
                detail={"missing": missing},
            )
        rate = 0
        takes: list[np.ndarray] = []
        for chunk in narration.chunks:
            frames, take_rate = read_frames(self._audio_path(chunk.adopted_audio_id))
            rate = rate or take_rate
            if take_rate != rate:
                raise ApiError(ErrorCode.INTERNAL_ERROR, "takes differ in sample rate")
            takes.append(assemble.trim_silence(frames.mean(axis=1), rate))
        pauses = narration.settings.pauses
        srt_mode = narration.format == "srt"
        audio, placed = assemble.join(
            takes,
            rate,
            gaps_ms=None
            if srt_mode
            else [_pause_ms(c.pause_after, pauses) for c in narration.chunks],
            starts_ms=[c.cue.start_ms if c.cue else None for c in narration.chunks]
            if srt_mode
            else None,
        )
        cues: list[SubtitleCue] = []
        for chunk, place in zip(narration.chunks, placed, strict=True):
            start = round(place.start * 1000 / rate)
            end = round((place.start + place.length) * 1000 / rate)
            if chunk.cue is not None and start == chunk.cue.start_ms:
                end = max(end, chunk.cue.end_ms)  # SRT input keeps its own timing
            cues.append(SubtitleCue(index=chunk.index, start_ms=start, end_ms=end, text=chunk.text))

        audio_id, duration = self._takes.write_assembled(narration_id, audio, rate)
        assembled = AssembledNarration(audio_id=audio_id, duration_s=duration, cues=cues)
        with self._db.transaction() as conn:
            conn.execute(
                "UPDATE narrations SET assembled_json = ? WHERE id = ?",
                (_dump(assembled.model_dump()), narration_id),
            )
        return assembled

    def export(self, narration_id: str, body: NarrationExportRequest) -> NarrationExported:
        narration = self.require(narration_id)
        requested = Path(body.path)
        if not requested.is_absolute() or requested.is_dir():
            raise ApiError(ErrorCode.SAVE_PATH_INVALID, "destination must be an absolute file")
        dest = export.destination(requested, body.format)
        if not dest.parent.is_dir():
            raise ApiError(ErrorCode.SAVE_PATH_INVALID, "destination folder does not exist")
        assembled = narration.assembled or self.assemble(narration_id)
        post = post_of(body.post)
        files: list[ExportedFile] = []
        self._export_audio(self._audio_path(assembled.audio_id), dest, body.format, post)
        files.append(ExportedFile(path=str(dest), bytes=dest.stat().st_size))
        cues = [
            srt.Cue(retimed(c.start_ms, post), retimed(c.end_ms, post), c.text)
            for c in assembled.cues
        ]
        for kind in dict.fromkeys(body.subtitles):
            text = srt.to_srt(cues) if kind == "srt" else srt.to_vtt(cues)
            path = dest.with_suffix(f".{kind}")
            try:
                path.write_bytes(text.encode("utf-8"))
            except OSError as exc:
                raise ApiError(save_error_code(exc), str(exc)) from exc
            files.append(ExportedFile(path=str(path), bytes=path.stat().st_size))
        if body.per_chunk:
            pairs = [
                (
                    self._audio_path(chunk.adopted_audio_id),
                    dest.with_name(f"{dest.stem}_{chunk.index + 1:03d}{dest.suffix}"),
                )
                for chunk in narration.chunks
            ]
            self._export_many(pairs, body.format, post)
            files += [ExportedFile(path=str(path), bytes=path.stat().st_size) for _, path in pairs]
        return NarrationExported(files=files)

    # --- Helpers --------------------------------------------------------------------------

    def _drafts(
        self,
        source: str,
        fmt: str,
        rules: SplitRules,
        settings: NarrationSettings,
    ) -> tuple[list[ChunkDraft], list[NarrationWarning]]:
        if rules.min_chars > rules.max_chars:
            raise ApiError(
                ErrorCode.INVALID_REQUEST,
                "min_chars exceeds max_chars",
                status_code=422,
                detail={"field": "rules"},
            )
        limit = self._host.spec.capabilities.max_output_seconds
        warnings: list[NarrationWarning] = []
        if fmt == "srt":
            try:
                cues = srt.parse(source)
            except srt.SubtitleError as exc:
                raise ApiError(ErrorCode.SUBTITLE_INVALID, str(exc), status_code=422) from exc
            drafts = split_cues(cues)
            previous_end = 0
            for index, cue in enumerate(cues):
                if (cue.end_ms - cue.start_ms) / 1000 > limit:
                    warnings.append(NarrationWarning(code="cue_too_long", index=index))
                if cue.start_ms < previous_end:
                    warnings.append(NarrationWarning(code="cue_overlap", index=index))
                previous_end = max(previous_end, cue.end_ms)
        else:
            text = markdown_to_text(source) if fmt == "markdown" else source
            drafts = split_text(
                text,
                min_chars=rules.min_chars,
                max_chars=rules.max_chars,
                max_seconds=limit * LENGTH_MARGIN,
                estimate=lambda t: self._estimate(t, settings.apply_dictionary),
            )
            warnings.extend(
                NarrationWarning(code="chunk_too_long", index=index)
                for index, draft in enumerate(drafts)
                if draft.estimated_seconds > limit
            )
        if not drafts:
            raise ApiError(ErrorCode.TEXT_EMPTY, "the manuscript has no text", status_code=422)
        if len(drafts) > MAX_CHUNKS:
            raise ApiError(
                ErrorCode.TEXT_TOO_LONG,
                "too many chunks",
                status_code=422,
                detail={"field": "source", "max_chunks": MAX_CHUNKS},
            )
        return drafts, warnings

    def _estimate(self, text: str, apply_dictionary: bool) -> float:
        spoken = self._dictionary.apply(text).text if apply_dictionary else text
        return self._reader.estimate_seconds(spoken)

    def _request(
        self,
        narration: Narration,
        chunk: NarrationChunk,
        reference: ReferenceClips | None = None,
        num_candidates: int | None = None,
    ) -> SynthesisRequest:
        settings = narration.settings
        # Only what was set: an explicit null ("off") must not fall back to the default.
        params = settings.params.model_dump(exclude_unset=True)
        if num_candidates is not None:
            params["num_candidates"] = num_candidates
        if chunk.cue is not None:
            # SRT input: say the line in the cue's time (clamped to the model's range).
            limit = self._host.spec.capabilities.max_output_seconds
            params["seconds"] = min(max((chunk.cue.end_ms - chunk.cue.start_ms) / 1000, 0.5), limit)
        return SynthesisRequest(
            text=chunk.text,
            caption=settings.caption,
            reference=reference or settings.reference,
            lora_adapter=settings.lora_adapter,
            params=SamplingParams(**params),
            apply_dictionary=settings.apply_dictionary,
        )

    def _validate_settings(self, settings: NarrationSettings) -> None:
        probe = NarrationChunk(index=0, text="確認", pause_after="sentence", estimated_seconds=1)
        narration = Narration.model_construct(settings=settings)  # only settings are read
        self._synthesis.prepare(self._request(narration, probe))

    def _lock_applies(self, settings: NarrationSettings) -> bool:
        """Voice lock (D18) when nothing else fixes the speaker."""
        if not settings.voice_lock:
            return False
        reference = settings.reference
        if reference.kind == "none":
            return True
        if reference.kind == "voice":
            voice = self._voices.get(reference.voice_id)
            return voice is not None and not voice.clips and voice.embedding is None
        return False

    def _lock_clip(self, narration: Narration) -> str:
        """The clip made from chunk 1's adopted take (created, or re-created after the
        take changed or the unowned clip was purged)."""
        first = narration.chunks[0].adopted_audio_id
        if first is None:
            raise ApiError(
                ErrorCode.NARRATION_INCOMPLETE,
                "voice lock needs chunk 1",
                status_code=409,
                detail={"missing": [0]},
            )
        row = self._db.query_one("SELECT lock_json FROM narrations WHERE id = ?", (narration.id,))
        lock = json.loads(row["lock_json"]) if row and row["lock_json"] else None
        if lock and lock.get("audio_id") == first and self._clips.get(lock.get("clip_id", "")):
            return str(lock["clip_id"])
        if lock and lock.get("clip_id"):
            self._clips.delete(str(lock["clip_id"]))
        clip = self._clips.add_file(self._audio_path(first), "voice-lock.wav", origin="generated")
        with self._db.transaction() as conn:
            conn.execute(
                "UPDATE narrations SET lock_json = ? WHERE id = ?",
                (_dump({"audio_id": first, "clip_id": clip.clip_id}), narration.id),
            )
        return clip.clip_id

    def _drop_lock(self, narration_id: str) -> None:
        row = self._db.query_one("SELECT lock_json FROM narrations WHERE id = ?", (narration_id,))
        lock = json.loads(row["lock_json"]) if row and row["lock_json"] else None
        if lock and lock.get("clip_id"):
            self._clips.delete(str(lock["clip_id"]))
        with self._db.transaction() as conn:
            conn.execute("UPDATE narrations SET lock_json = NULL WHERE id = ?", (narration_id,))

    def _store_takes(
        self, narration_id: str, chunk: NarrationChunk, done: Synthesized
    ) -> list[Take]:
        def commit(conn: Any, takes: list[Take]) -> bool:
            current = conn.execute(
                "SELECT text FROM narration_chunks WHERE narration_id = ? AND idx = ?",
                (narration_id, chunk.index),
            ).fetchone()
            if current is None or current["text"] != chunk.text:
                return False  # edited or re-split meanwhile
            conn.execute(
                "UPDATE narration_chunks SET adopted_audio_id = ?"
                " WHERE narration_id = ? AND idx = ?",
                (takes[0].audio_id, narration_id, chunk.index),
            )
            return True

        # A cue sets the length itself: an SRT take at the limit is not cut off.
        limit = None if chunk.cue else self._host.spec.capabilities.max_output_seconds
        takes = self._takes.write(narration_id, chunk.index, done, limit_s=limit, commit=commit)
        if takes:
            self._touch(narration_id)
            self._drop_assembled(narration_id)
        return takes

    def _drop_audio(self, narration_id: str, which: Any) -> None:
        """Delete the takes of the chunks selected by `which(index)`."""
        if self._takes.drop(narration_id, which):
            self._drop_assembled(narration_id)

    def _drop_assembled(self, narration_id: str) -> None:
        with self._db.transaction() as conn:
            conn.execute(
                "UPDATE narrations SET assembled_json = NULL WHERE id = ?", (narration_id,)
            )
        self._takes.drop_assembled(narration_id)

    def _touch(self, narration_id: str) -> None:
        with self._db.transaction() as conn:
            conn.execute(
                "UPDATE narrations SET updated_at = ? WHERE id = ?", (now_iso(), narration_id)
            )

    def _ensure_idle(self, narration_id: str) -> None:
        if self.busy(narration_id):
            raise ApiError(ErrorCode.NARRATION_BUSY, "a render is in progress", status_code=409)

    def _audio_path(self, audio_id: str | None) -> Path:
        return self._takes.path(audio_id)

    def _export_audio(self, source: Path, dest: Path, fmt: str, post: Post | None) -> None:
        try:
            export.export_audio(source, dest, fmt, ffmpeg=self._ffmpeg, post=post)
        except export.ExportError as exc:
            raise ApiError(ErrorCode.parse(exc.code), str(exc)) from exc

    def _export_many(self, pairs: list[tuple[Path, Path]], fmt: str, post: Post | None) -> None:
        try:
            export.export_many(pairs, fmt, ffmpeg=self._ffmpeg, post=post)
        except export.ExportError as exc:
            raise ApiError(ErrorCode.parse(exc.code), str(exc)) from exc

    def _narration(self, row: Any) -> Narration:
        narration_id = row["id"]
        takes = self._takes.by_item(narration_id)
        chunks = [
            NarrationChunk(
                index=c["idx"],
                text=c["text"],
                pause_after=c["pause_after"],
                estimated_seconds=c["estimated_seconds"],
                cue=Cue(start_ms=c["cue_start_ms"], end_ms=c["cue_end_ms"])
                if c["cue_start_ms"] is not None
                else None,
                takes=takes.get(c["idx"], []),
                adopted_audio_id=c["adopted_audio_id"],
            )
            for c in self._db.query(
                "SELECT * FROM narration_chunks WHERE narration_id = ? ORDER BY idx",
                (narration_id,),
            )
        ]
        assembled = json.loads(row["assembled_json"]) if row["assembled_json"] else None
        return Narration(
            id=narration_id,
            title=row["title"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            format=row["format"],
            source=row["source"],
            rules=SplitRules(**json.loads(row["rules_json"])),
            settings=NarrationSettings(**json.loads(row["settings_json"])),
            chunks=chunks,
            warnings=[NarrationWarning(**w) for w in json.loads(row["warnings_json"])],
            assembled=AssembledNarration(**assembled) if assembled else None,
            analyzer=self._reader.available,
            render_job_id=self._active.get(narration_id) if self.busy(narration_id) else None,
        )


def _insert_chunks(conn: Any, narration_id: str, drafts: list[ChunkDraft]) -> None:
    conn.executemany(
        "INSERT INTO narration_chunks (narration_id, idx, text, pause_after, estimated_seconds,"
        " cue_start_ms, cue_end_ms) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [
            (
                narration_id, index, draft.text, draft.pause_after, draft.estimated_seconds,
                draft.cue.start_ms if draft.cue else None, draft.cue.end_ms if draft.cue else None,
            )
            for index, draft in enumerate(drafts)
        ],
    )  # fmt: skip


def _chunk(narration: Narration, index: int) -> NarrationChunk:
    if not 0 <= index < len(narration.chunks):
        raise ApiError(ErrorCode.CHUNK_NOT_FOUND, "chunk not found", status_code=404)
    return narration.chunks[index]


def _pause_ms(kind: str, pauses: Any) -> int:
    if kind == "paragraph":
        return int(pauses.paragraph_ms)
    if kind == "clause":
        return round(pauses.sentence_ms * CLAUSE_PAUSE_SHARE)
    return int(pauses.sentence_ms)


def _title_from(drafts: list[ChunkDraft]) -> str:
    first = drafts[0].text if drafts else ""
    return first if len(first) <= 30 else first[:30] + "…"


def _settings_dump(settings: NarrationSettings) -> dict[str, Any]:
    """Settings as stored: parameters keep only the values that were set (including an
    explicit null, which means "off" for some of them)."""
    data = settings.model_dump(mode="json")
    data["params"] = settings.params.model_dump(mode="json", exclude_unset=True)
    return data


def _dump(value: object) -> str:
    return json.dumps(value, ensure_ascii=False)
