"""Scripts (requirements §6.7): dialogue lines with speakers, rendered line by line on the
synthesis queue (D24) with takes to choose from, and exported as one file per line (named
by a template), a merged drama and subtitles, plus a CSV / TSV table for game engines.

Each speaker may be mapped to a library voice, which supplies the reference and its
defaults (caption, parameters, seed, LoRA); script settings and a line's own values
override them. Lines have stable ids, so their takes survive inserting, deleting and
reordering lines.
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
    AssembledScript,
    ExportedFile,
    FileNames,
    LineInsert,
    LineMove,
    LinePatch,
    ReferenceNone,
    ReferenceVoice,
    SamplingParams,
    Script,
    ScriptCreate,
    ScriptCue,
    ScriptExported,
    ScriptExportRequest,
    ScriptImport,
    ScriptLine,
    ScriptLineInput,
    ScriptPatch,
    ScriptRenderRequest,
    ScriptSettings,
    ScriptSpeaker,
    ScriptSummary,
    ScriptTableRequest,
    SynthesisRequest,
    Take,
)
from app.services.job_manager import Job, JobManager, now_iso
from app.services.queue import SynthesisQueue
from app.services.synthesis import RunHooks, SynthesisService, Synthesized
from app.services.takes import TakeAudio, TakeStore
from app.services.voices import VoiceService
from app.storage.db import Database
from app.storage.files import DataLayout, is_id, new_id, remove_tree
from app.text import naming, srt
from app.text.script_parser import LineDraft, ScriptError, parse_table, parse_text, to_table

log = logging.getLogger("irodori.script")

MAX_LINES = 5000
TEMPLATE_TOKENS = frozenset({"index", "n", "speaker", "text_head", "title", "id"})
_BOM = chr(0xFEFF)


@dataclass(frozen=True)
class ScriptRenderPayload:
    script_id: str
    line_ids: tuple[str, ...]
    num_candidates: int | None


@dataclass(frozen=True)
class RestoredLine:
    """A line as a project file saved it, with its adopted take."""

    draft: LineDraft
    take: TakeAudio | None


class ScriptService:
    def __init__(
        self,
        *,
        db: Database,
        layout: DataLayout,
        host: EngineHost,
        synthesis: SynthesisService,
        voices: VoiceService,
        jobs: JobManager,
        queue: SynthesisQueue,
        ffmpeg: Path | None,
    ) -> None:
        self._db = db
        self._layout = layout
        self._host = host
        self._synthesis = synthesis
        self._voices = voices
        self._jobs = jobs
        self._queue = queue
        self._ffmpeg = ffmpeg
        self._takes = TakeStore(db, layout, owner="script_id", item="line_id", root=layout.scripts)
        self._active: dict[str, str] = {}  # script id -> its render job

    # --- Queries ----------------------------------------------------------------------------

    def list(self) -> list[ScriptSummary]:
        rows = self._db.query(
            "SELECT s.*,"
            " (SELECT COUNT(*) FROM script_lines l WHERE l.script_id = s.id) AS lines,"
            " (SELECT COUNT(*) FROM script_lines l WHERE l.script_id = s.id"
            "   AND l.adopted_audio_id IS NOT NULL) AS rendered"
            " FROM scripts s ORDER BY s.updated_at DESC, s.id DESC"
        )
        return [
            ScriptSummary(
                id=row["id"],
                title=row["title"],
                created_at=row["created_at"],
                updated_at=row["updated_at"],
                lines=row["lines"],
                rendered=row["rendered"],
                speakers=len(json.loads(row["speakers_json"])),
            )
            for row in rows
        ]

    def get(self, script_id: str) -> Script | None:
        if not is_id(script_id):
            return None
        row = self._db.query_one("SELECT * FROM scripts WHERE id = ?", (script_id,))
        return None if row is None else self._script(row)

    def require(self, script_id: str) -> Script:
        script = self.get(script_id)
        if script is None:
            raise ApiError(ErrorCode.SCRIPT_NOT_FOUND, "script not found", status_code=404)
        return script

    def busy(self, script_id: str) -> bool:
        job_id = self._active.get(script_id)
        job = self._jobs.get(job_id) if job_id else None
        return job is not None and not job.finished

    # --- Create and edit --------------------------------------------------------------------

    def create(self, body: ScriptCreate) -> Script:
        drafts = self._parse(body.source, body.format)
        self._validate_settings(body.settings)
        script_id = new_id()
        now = now_iso()
        title = (body.title or "").strip() or _title_from(drafts)
        speakers = _merge_speakers([], drafts)
        with self._db.transaction() as conn:
            conn.execute(
                "INSERT INTO scripts (id, title, created_at, updated_at, speakers_json,"
                " settings_json) VALUES (?, ?, ?, ?, ?, ?)",
                (
                    script_id, title, now, now, _dump([s.model_dump() for s in speakers]),
                    _dump(_settings_dump(body.settings)),
                ),
            )  # fmt: skip
            _insert_lines(conn, script_id, 0, drafts)
        return self.require(script_id)

    def restore(
        self,
        *,
        title: str,
        speakers: list[ScriptSpeaker],
        settings: ScriptSettings,
        lines: list[RestoredLine],
    ) -> Script:
        """A script as a project file saved it, with the lines' adopted takes."""
        script_id = new_id()
        now = now_iso()
        drafts = [line.draft for line in lines]
        with self._db.transaction() as conn:
            conn.execute(
                "INSERT INTO scripts (id, title, created_at, updated_at, speakers_json,"
                " settings_json) VALUES (?, ?, ?, ?, ?, ?)",
                (
                    script_id, title, now, now,
                    _dump([s.model_dump() for s in _merge_speakers(speakers, drafts)]),
                    _dump(_settings_dump(settings)),
                ),
            )  # fmt: skip
            _insert_lines(conn, script_id, 0, drafts)
        rows = self._db.query(
            "SELECT id FROM script_lines WHERE script_id = ? ORDER BY position", (script_id,)
        )
        for row, line in zip(rows, lines, strict=True):
            if line.take is None:
                continue
            audio_id = self._takes.restore(script_id, row["id"], line.take)
            with self._db.transaction() as conn:
                conn.execute(
                    "UPDATE script_lines SET adopted_audio_id = ? WHERE id = ?",
                    (audio_id, row["id"]),
                )
        return self.require(script_id)

    def import_lines(self, script_id: str, body: ScriptImport) -> Script:
        script = self.require(script_id)
        self._ensure_idle(script_id)
        drafts = self._parse(body.source, body.format)
        replace = body.mode == "replace"
        if not replace and len(script.lines) + len(drafts) > MAX_LINES:
            raise _too_many()
        speakers = _merge_speakers(script.speakers, drafts)
        with self._db.transaction() as conn:
            if replace:
                conn.execute("DELETE FROM script_lines WHERE script_id = ?", (script_id,))
            _insert_lines(conn, script_id, 0 if replace else len(script.lines), drafts)
            conn.execute(
                "UPDATE scripts SET speakers_json = ?, updated_at = ? WHERE id = ?",
                (_dump([s.model_dump() for s in speakers]), now_iso(), script_id),
            )
        if replace:
            self._takes.drop(script_id, lambda item: True)
        self._drop_assembled(script_id)
        return self.require(script_id)

    def update(self, script_id: str, body: ScriptPatch) -> Script:
        script = self.require(script_id)
        columns: dict[str, Any] = {}
        changes = body.model_fields_set
        if "title" in changes and body.title:
            columns["title"] = body.title.strip()
        if "settings" in changes and body.settings is not None:
            self._validate_settings(body.settings)
            columns["settings_json"] = _dump(_settings_dump(body.settings))
        if "speakers" in changes and body.speakers is not None:
            names = [speaker.name.strip() for speaker in body.speakers]
            if len(set(names)) != len(names):
                raise ApiError(
                    ErrorCode.SCRIPT_INVALID,
                    "speaker names must be unique",
                    status_code=422,
                    detail={"reason": "speakers"},
                )
            for speaker in body.speakers:
                if speaker.voice_id and self._voices.get(speaker.voice_id) is None:
                    raise ApiError(ErrorCode.VOICE_NOT_FOUND, "voice not found", status_code=404)
            given = [
                ScriptSpeaker(
                    name=speaker.name.strip(),
                    voice_id=speaker.voice_id or None,
                    caption=(speaker.caption or "").strip() or None,
                )
                for speaker in body.speakers
            ]
            # Every speaker a line uses keeps an entry.
            speakers = _merge_speakers(given, _drafts_of(script.lines))
            columns["speakers_json"] = _dump([s.model_dump() for s in speakers])
        if columns:
            columns["updated_at"] = now_iso()
            assignments = ", ".join(f"{column} = ?" for column in columns)
            with self._db.transaction() as conn:
                conn.execute(
                    f"UPDATE scripts SET {assignments} WHERE id = ?", [*columns.values(), script_id]
                )
            if "settings_json" in columns or "speakers_json" in columns:
                self._drop_assembled(script_id)  # pauses or subtitle speakers may differ
        return self.require(script_id)

    def update_line(self, script_id: str, line_id: str, body: LinePatch) -> Script:
        script = self.require(script_id)
        line = _line(script, line_id)
        changes = body.model_fields_set
        columns: dict[str, Any] = {}
        for name in ("caption", "file_name"):
            if name in changes:
                columns[name] = (getattr(body, name) or "").strip() or None
        for name in ("num_candidates", "seed", "pause_ms"):
            if name in changes:
                columns[name] = getattr(body, name)
        stale = False
        if "speaker" in changes and (body.speaker or "").strip() != line.speaker:
            columns["speaker"] = (body.speaker or "").strip()
            stale = True
        if "text" in changes and body.text is not None and body.text.strip() != line.text:
            columns["text"] = body.text.strip()
            stale = True
        if stale:
            columns["adopted_audio_id"] = None
        elif "adopted_audio_id" in changes:
            audio_id = body.adopted_audio_id
            if audio_id is not None and audio_id not in {t.audio_id for t in line.takes}:
                raise ApiError(
                    ErrorCode.AUDIO_NOT_FOUND, "not a take of this line", status_code=404
                )
            columns["adopted_audio_id"] = audio_id
        if columns:
            assignments = ", ".join(f"{column} = ?" for column in columns)
            with self._db.transaction() as conn:
                conn.execute(
                    f"UPDATE script_lines SET {assignments} WHERE id = ? AND script_id = ?",
                    [*columns.values(), line_id, script_id],
                )
            if stale:
                # A take of other words, or of another voice, is useless.
                self._takes.drop(script_id, lambda item: item == line_id)
            if "speaker" in columns:
                self._add_speakers(script, [columns["speaker"]])
            self._touch(script_id)
            self._drop_assembled(script_id)
        return self.require(script_id)

    def insert_line(self, script_id: str, body: LineInsert) -> Script:
        script = self.require(script_id)
        if len(script.lines) >= MAX_LINES:
            raise _too_many()
        position = (
            len(script.lines) if body.position is None else min(body.position, len(script.lines))
        )
        draft = _draft(body.line)
        with self._db.transaction() as conn:
            conn.execute(
                "UPDATE script_lines SET position = position + 1"
                " WHERE script_id = ? AND position >= ?",
                (script_id, position),
            )
            _insert_lines(conn, script_id, position, [draft])
        self._add_speakers(script, [draft.speaker])
        self._touch(script_id)
        self._drop_assembled(script_id)
        return self.require(script_id)

    def delete_line(self, script_id: str, line_id: str) -> Script:
        script = self.require(script_id)
        line = _line(script, line_id)
        with self._db.transaction() as conn:
            conn.execute("DELETE FROM script_lines WHERE id = ?", (line_id,))
            conn.execute(
                "UPDATE script_lines SET position = position - 1"
                " WHERE script_id = ? AND position > ?",
                (script_id, line.index),
            )
        self._takes.drop(script_id, lambda item: item == line_id)
        self._touch(script_id)
        self._drop_assembled(script_id)
        return self.require(script_id)

    def move_line(self, script_id: str, line_id: str, body: LineMove) -> Script:
        script = self.require(script_id)
        line = _line(script, line_id)
        order = [other.id for other in script.lines if other.id != line_id]
        order.insert(min(body.position, len(order)), line.id)
        with self._db.transaction() as conn:
            conn.executemany(
                "UPDATE script_lines SET position = ? WHERE id = ?",
                [(position, lid) for position, lid in enumerate(order)],
            )
        self._touch(script_id)
        self._drop_assembled(script_id)
        return self.require(script_id)

    def delete(self, script_id: str) -> bool:
        if self.get(script_id) is None:
            return False
        self._ensure_idle(script_id)
        with self._db.transaction() as conn:
            # Lines and audio rows go with it (ON DELETE CASCADE).
            conn.execute("DELETE FROM scripts WHERE id = ?", (script_id,))
        remove_tree(self._layout.scripts / script_id)
        return True

    # --- Rendering --------------------------------------------------------------------------

    def enqueue_render(self, script_id: str, body: ScriptRenderRequest) -> Job | None:
        script = self.require(script_id)
        self._ensure_idle(script_id)
        if body.line_ids is None:
            wanted = [line for line in script.lines if body.redo or not line.adopted_audio_id]
        else:
            chosen = set(body.line_ids)
            for line_id in chosen:
                _line(script, line_id)
            wanted = [line for line in script.lines if line.id in chosen]
            if not body.redo:
                wanted = [line for line in wanted if not line.adopted_audio_id]
        if not wanted:
            return None
        # Fail now, not in the worker: consent, LoRA, parameters, the voice itself.
        self._synthesis.prepare(self._request(script, wanted[0]))
        job = self._jobs.create(
            "script",
            "ui",
            ScriptRenderPayload(script_id, tuple(line.id for line in wanted), body.num_candidates),
        )
        self._active[script_id] = job.id
        self._queue.submit(job)
        return job

    def execute_render(self, job: Job) -> None:
        payload: ScriptRenderPayload = job.payload
        if job.cancel_requested.is_set():
            job.mark_cancelled()
            return
        job.mark_started()
        rendered = 0
        try:
            for n, line_id in enumerate(payload.line_ids):
                if job.cancel_requested.is_set():
                    job.mark_cancelled()
                    return
                script = self.require(payload.script_id)
                line = next((other for other in script.lines if other.id == line_id), None)
                if line is None:
                    continue  # deleted meanwhile
                prepared = self._synthesis.prepare(
                    self._request(script, line, payload.num_candidates)
                )

                def on_log(text: str) -> None:
                    log.info("[%s] %s", job.id, text)
                    job.emit("log", line=text)

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
                takes = self._store_takes(script.id, line, done)
                if takes:
                    rendered += 1
                    job.emit(
                        "line",
                        line_id=line.id,
                        index=line.index,
                        takes=[take.model_dump() for take in takes],
                        adopted_audio_id=takes[0].audio_id,
                    )
                job.emit("progress", done=n + 1, total=len(payload.line_ids), unit="line")
        except SynthesisCancelled:
            job.mark_cancelled()
            return
        except BackendError as exc:
            log.warning("script job %s failed: %s %s", job.id, exc.code, exc.message)
            job.mark_failed(ErrorCode.parse(exc.code).value, exc.message)
            return
        except ApiError as exc:
            job.mark_failed(exc.code.value, exc.message)
            return
        except Exception as exc:
            log.exception("script job %s failed", job.id)
            job.mark_failed(job_failure_code(exc).value, f"{type(exc).__name__}: {exc}")
            return
        job.mark_completed({"script_id": payload.script_id, "rendered": rendered})

    # --- Assemble and export ----------------------------------------------------------------

    def assemble(self, script_id: str) -> AssembledScript:
        script = self.require(script_id)
        missing = [line.id for line in script.lines if not line.adopted_audio_id]
        if missing:
            raise ApiError(
                ErrorCode.SCRIPT_INCOMPLETE,
                "some lines have no take",
                status_code=409,
                detail={"missing": missing},
            )
        rate = 0
        takes: list[np.ndarray] = []
        for line in script.lines:
            frames, take_rate = read_frames(self._takes.path(line.adopted_audio_id))
            rate = rate or take_rate
            if take_rate != rate:
                raise ApiError(ErrorCode.INTERNAL_ERROR, "takes differ in sample rate")
            takes.append(assemble.trim_silence(frames.mean(axis=1), rate))
        gaps = [
            line.pause_ms if line.pause_ms is not None else script.settings.pause_ms
            for line in script.lines
        ]
        audio, placed = assemble.join(takes, rate, gaps_ms=gaps)
        cues = [
            ScriptCue(
                index=line.index,
                line_id=line.id,
                speaker=line.speaker,
                start_ms=round(place.start * 1000 / rate),
                end_ms=round((place.start + place.length) * 1000 / rate),
                text=line.text,
            )
            for line, place in zip(script.lines, placed, strict=True)
        ]
        audio_id, duration = self._takes.write_assembled(script_id, audio, rate)
        assembled = AssembledScript(audio_id=audio_id, duration_s=duration, cues=cues)
        with self._db.transaction() as conn:
            conn.execute(
                "UPDATE scripts SET assembled_json = ? WHERE id = ?",
                (_dump(assembled.model_dump()), script_id),
            )
        return assembled

    def export(self, script_id: str, body: ScriptExportRequest) -> ScriptExported:
        script = self.require(script_id)
        folder = Path(body.folder)
        if not folder.is_absolute() or not folder.is_dir():
            raise ApiError(ErrorCode.SAVE_PATH_INVALID, "choose an existing folder")
        missing = [line.id for line in script.lines if not line.adopted_audio_id]
        if missing:
            raise ApiError(
                ErrorCode.SCRIPT_INCOMPLETE,
                "some lines have no take",
                status_code=409,
                detail={"missing": missing},
            )
        extension = export.EXTENSIONS[body.format]
        post = post_of(body.post)
        files: list[ExportedFile] = []
        if body.per_line:
            pairs = [
                (self._takes.path(line.adopted_audio_id), folder / f"{name}{extension}")
                for line, name in zip(script.lines, self.file_names(script), strict=True)
            ]
            self._export_many(pairs, body.format, post)
            files += [ExportedFile(path=str(path), bytes=path.stat().st_size) for _, path in pairs]
        if body.merged:
            assembled = script.assembled or self.assemble(script_id)
            stem = naming.safe(script.title) or "script"
            path = folder / f"{stem}{extension}"
            self._export_audio(self._takes.path(assembled.audio_id), path, body.format, post)
            files.append(ExportedFile(path=str(path), bytes=path.stat().st_size))
            for kind in dict.fromkeys(body.subtitles):
                cues = [
                    srt.Cue(
                        retimed(cue.start_ms, post),
                        retimed(cue.end_ms, post),
                        self._cue_text(script, cue, kind),
                    )
                    for cue in assembled.cues
                ]
                text = srt.to_srt(cues) if kind == "srt" else srt.to_vtt(cues)
                subtitle = folder / f"{stem}.{kind}"
                try:
                    subtitle.write_bytes(text.encode("utf-8"))
                except OSError as exc:
                    raise ApiError(save_error_code(exc), str(exc)) from exc
                files.append(ExportedFile(path=str(subtitle), bytes=subtitle.stat().st_size))
        return ScriptExported(files=files)

    def export_table(self, script_id: str, body: ScriptTableRequest) -> ExportedFile:
        script = self.require(script_id)
        requested = Path(body.path)
        if not requested.is_absolute() or requested.is_dir():
            raise ApiError(ErrorCode.SAVE_PATH_INVALID, "destination must be an absolute file")
        suffix = f".{body.format}"
        dest = requested if requested.suffix.lower() == suffix else requested.with_suffix(suffix)
        if not dest.parent.is_dir():
            raise ApiError(ErrorCode.SAVE_PATH_INVALID, "destination folder does not exist")
        table = to_table(_drafts_of(script.lines), "\t" if body.format == "tsv" else ",")
        try:
            # With a BOM, Excel opens UTF-8 correctly; this app reads either.
            dest.write_bytes((_BOM + table).encode("utf-8"))
        except OSError as exc:
            raise ApiError(save_error_code(exc), str(exc)) from exc
        return ExportedFile(path=str(dest), bytes=dest.stat().st_size)

    def preview_names(self, script_id: str, template: str) -> FileNames:
        """The per-line file names a naming template would give (before saving it)."""
        script = self.require(script_id)
        _check_template(template)
        settings = script.settings.model_copy(update={"naming_template": template})
        return FileNames(names=self.file_names(script.model_copy(update={"settings": settings})))

    def file_names(self, script: Script) -> list[str]:
        """Per-line file names (without extension): the line's own name, else the
        template; made safe for Windows and macOS and unique within the script."""
        unique = naming.UniqueNames()
        names: list[str] = []
        for line in script.lines:
            if line.file_name:
                name = naming.safe(line.file_name)
            else:
                values = {
                    "index": naming.zero_padded(line.index + 1, len(script.lines)),
                    "n": str(line.index + 1),
                    "speaker": line.speaker,
                    "text_head": line.text[: naming.TEXT_HEAD_CHARS],
                    "title": script.title,
                    "id": line.id,
                }
                name = naming.safe(naming.fill(script.settings.naming_template, values))
            names.append(unique.take(name or f"line_{line.index + 1}"))
        return names

    # --- Helpers ----------------------------------------------------------------------------

    def _parse(self, source: str, fmt: str) -> list[LineDraft]:
        try:
            if fmt == "text":
                drafts = parse_text(source)
            else:
                drafts = parse_table(source, "\t" if fmt == "tsv" else ",")
        except ScriptError as exc:
            raise ApiError(
                ErrorCode.SCRIPT_INVALID,
                f"cannot read the script: {exc.reason}",
                status_code=422,
                detail={"reason": exc.reason, **exc.detail},
            ) from exc
        if len(drafts) > MAX_LINES:
            raise _too_many()
        for number, draft in enumerate(drafts, start=1):
            try:
                ScriptLineInput(**_line_input(draft))
            except ValueError as exc:
                raise ApiError(
                    ErrorCode.SCRIPT_INVALID,
                    "a line is out of range",
                    status_code=422,
                    detail={"reason": "value", "line": number},
                ) from exc
        return drafts

    def _validate_settings(self, settings: ScriptSettings) -> None:
        _check_template(settings.naming_template)
        self._synthesis.prepare(
            SynthesisRequest(text="確認", params=settings.params, apply_dictionary=False)
        )

    def _request(
        self, script: Script, line: ScriptLine, num_candidates: int | None = None
    ) -> SynthesisRequest:
        """voice defaults < script settings < the line's own values."""
        speaker = next((s for s in script.speakers if s.name == line.speaker), None)
        voice = self._voices.get(speaker.voice_id) if speaker and speaker.voice_id else None
        params: dict[str, Any] = dict(voice.params_default) if voice else {}
        # Only what was set: an explicit null ("off") must not fall back to the default.
        params.update(script.settings.params.model_dump(exclude_unset=True))
        if line.seed is not None:
            params["seed"] = line.seed
        elif "seed" not in params and voice and voice.seed_default is not None:
            params["seed"] = voice.seed_default
        if line.num_candidates is not None:
            params["num_candidates"] = line.num_candidates
        if num_candidates is not None:
            params["num_candidates"] = num_candidates
        caption = line.caption or (speaker.caption if speaker else None)
        if caption is None and voice is not None:
            caption = voice.caption_default
        return SynthesisRequest(
            text=line.text,
            caption=caption,
            reference=ReferenceVoice(kind="voice", voice_id=voice.id) if voice else ReferenceNone(),
            lora_adapter=voice.lora_path if voice else None,
            params=SamplingParams(**params),
            apply_dictionary=script.settings.apply_dictionary,
        )

    def _cue_text(self, script: Script, cue: ScriptCue, kind: str) -> str:
        if not script.settings.subtitle_speakers or not cue.speaker:
            return cue.text
        if kind == "vtt":
            speaker = cue.speaker.replace("<", "").replace(">", "")
            return f"<v {speaker}>{cue.text}"
        return f"{cue.speaker}：{cue.text}"

    def _store_takes(self, script_id: str, line: ScriptLine, done: Synthesized) -> list[Take]:
        def commit(conn: Any, takes: list[Take]) -> bool:
            current = conn.execute(
                "SELECT text, speaker FROM script_lines WHERE id = ? AND script_id = ?",
                (line.id, script_id),
            ).fetchone()
            if current is None or (current["text"], current["speaker"]) != (
                line.text,
                line.speaker,
            ):
                return False  # edited or deleted meanwhile
            conn.execute(
                "UPDATE script_lines SET adopted_audio_id = ? WHERE id = ?",
                (takes[0].audio_id, line.id),
            )
            return True

        limit = self._host.spec.capabilities.max_output_seconds
        takes = self._takes.write(script_id, line.id, done, limit_s=limit, commit=commit)
        if takes:
            self._touch(script_id)
            self._drop_assembled(script_id)
        return takes

    def _add_speakers(self, script: Script, names: list[str]) -> None:
        missing = [name for name in names if name not in {s.name for s in script.speakers}]
        if not missing:
            return
        speakers = [*script.speakers, *(ScriptSpeaker(name=name) for name in missing)]
        with self._db.transaction() as conn:
            conn.execute(
                "UPDATE scripts SET speakers_json = ? WHERE id = ?",
                (_dump([s.model_dump() for s in speakers]), script.id),
            )

    def _drop_assembled(self, script_id: str) -> None:
        with self._db.transaction() as conn:
            conn.execute("UPDATE scripts SET assembled_json = NULL WHERE id = ?", (script_id,))
        self._takes.drop_assembled(script_id)

    def _touch(self, script_id: str) -> None:
        with self._db.transaction() as conn:
            conn.execute("UPDATE scripts SET updated_at = ? WHERE id = ?", (now_iso(), script_id))

    def _ensure_idle(self, script_id: str) -> None:
        if self.busy(script_id):
            raise ApiError(ErrorCode.SCRIPT_BUSY, "a render is in progress", status_code=409)

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

    def _script(self, row: Any) -> Script:
        script_id = row["id"]
        takes = self._takes.by_item(script_id)
        lines = [
            ScriptLine(
                id=r["id"],
                index=index,
                speaker=r["speaker"],
                text=r["text"],
                caption=r["caption"],
                num_candidates=r["num_candidates"],
                seed=r["seed"],
                pause_ms=r["pause_ms"],
                file_name=r["file_name"],
                takes=takes.get(r["id"], []),
                adopted_audio_id=r["adopted_audio_id"],
            )
            for index, r in enumerate(
                self._db.query(
                    "SELECT * FROM script_lines WHERE script_id = ? ORDER BY position, id",
                    (script_id,),
                )
            )
        ]
        assembled = json.loads(row["assembled_json"]) if row["assembled_json"] else None
        return Script(
            id=script_id,
            title=row["title"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            speakers=[ScriptSpeaker(**s) for s in json.loads(row["speakers_json"])],
            settings=ScriptSettings(**json.loads(row["settings_json"])),
            lines=lines,
            assembled=AssembledScript(**assembled) if assembled else None,
            render_job_id=self._active.get(script_id) if self.busy(script_id) else None,
        )


def _insert_lines(conn: Any, script_id: str, start: int, drafts: list[LineDraft]) -> None:
    conn.executemany(
        "INSERT INTO script_lines (id, script_id, position, speaker, text, caption,"
        " num_candidates, seed, pause_ms, file_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
            (
                new_id(), script_id, start + offset, d.speaker, d.text, d.caption,
                d.num_candidates, d.seed, d.pause_ms, d.file_name,
            )
            for offset, d in enumerate(drafts)
        ],
    )  # fmt: skip


def _merge_speakers(speakers: list[ScriptSpeaker], drafts: list[LineDraft]) -> list[ScriptSpeaker]:
    """`speakers` plus an entry for every other speaker the lines use, in order."""
    merged = list(speakers)
    known = {speaker.name for speaker in merged}
    for draft in drafts:
        if draft.speaker not in known:
            merged.append(ScriptSpeaker(name=draft.speaker))
            known.add(draft.speaker)
    return merged


def _draft(line: ScriptLineInput) -> LineDraft:
    return LineDraft(
        speaker=line.speaker.strip(),
        text=line.text.strip(),
        caption=(line.caption or "").strip() or None,
        num_candidates=line.num_candidates,
        seed=line.seed,
        pause_ms=line.pause_ms,
        file_name=(line.file_name or "").strip() or None,
    )


def _drafts_of(lines: list[ScriptLine]) -> list[LineDraft]:
    return [_draft(line) for line in lines]


def _line_input(draft: LineDraft) -> dict[str, Any]:
    return {
        "speaker": draft.speaker,
        "text": draft.text,
        "caption": draft.caption,
        "num_candidates": draft.num_candidates,
        "seed": draft.seed,
        "pause_ms": draft.pause_ms,
        "file_name": draft.file_name,
    }


def _line(script: Script, line_id: str) -> ScriptLine:
    line = next((line for line in script.lines if line.id == line_id), None)
    if line is None:
        raise ApiError(ErrorCode.LINE_NOT_FOUND, "line not found", status_code=404)
    return line


def _check_template(template: str) -> None:
    try:
        naming.check(template, TEMPLATE_TOKENS)
    except naming.TemplateError as exc:
        raise ApiError(
            ErrorCode.NAMING_TEMPLATE_INVALID,
            "unknown template field",
            status_code=422,
            detail={"token": exc.token},
        ) from exc


def _title_from(drafts: list[LineDraft]) -> str:
    first = drafts[0].text if drafts else ""
    return first if len(first) <= 30 else first[:30] + "…"


def _too_many() -> ApiError:
    return ApiError(
        ErrorCode.TEXT_TOO_LONG,
        "too many lines",
        status_code=422,
        detail={"field": "source", "max_lines": MAX_LINES},
    )


def _settings_dump(settings: ScriptSettings) -> dict[str, Any]:
    """Settings as stored: parameters keep only the values that were set."""
    data = settings.model_dump(mode="json")
    data["params"] = settings.params.model_dump(mode="json", exclude_unset=True)
    return data


def _dump(value: object) -> str:
    return json.dumps(value, ensure_ascii=False)
