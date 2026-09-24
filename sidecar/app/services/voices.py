"""The voice library (requirements §6.5, Session 4).

A voice is a named speaker identity plus its defaults:
- designed: a caption, and usually the adopted candidate kept as its reference clip;
- imported / recorded: reference clips of a real person — consent is required (D13);
- embedding: a Speaker Inversion `.speaker.safetensors`.

Clips live in the clip store (one float32 WAV + cached latents each); a voice owns an
ordered set of them. After a change, the clips are encoded for the active model on the
synthesis queue ("encode on save"), so generations skip the encoder. Voices travel as
`.irovoice` packages (D22): voice.json + FLAC clips + optional embedding, never latents.
"""

from __future__ import annotations

import io
import json
import logging
import shutil
import struct
import tempfile
import zipfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, BinaryIO

import soundfile as sf
from pydantic import ValidationError

from app.engine import params as param_table
from app.engine.base import BackendError
from app.engine.host import EngineHost
from app.errors import ApiError, ErrorCode
from app.schemas import (
    Consent,
    ConsentInput,
    EmbeddingInfo,
    ExportedFile,
    SamplingParams,
    Voice,
    VoiceCreate,
    VoicePatch,
    VoiceSaved,
)
from app.services.clips import REAL_VOICE_ORIGINS, ClipStore, latent_key
from app.services.history import HistoryStore
from app.services.job_manager import Job, JobManager, now_iso
from app.services.queue import SynthesisQueue
from app.storage.db import Database
from app.storage.files import DataLayout, is_id, new_id, remove_tree

log = logging.getLogger("irodori.voices")

# Upstream loads Speaker Inversion files only with this suffix.
EMBEDDING_FILE = "voice.speaker.safetensors"
EMBEDDING_KEY = "speaker_embedding"
EMBEDDING_DTYPES = frozenset({"F16", "BF16", "F32", "F64"})
PACKAGE_FORMAT = "irovoice"
PACKAGE_VERSION = 1
MAX_PACKAGE_BYTES = 400 * 1024 * 1024
CONSENT_VERSION = 1
REAL_VOICE_SOURCES = frozenset({"imported", "recorded"})


@dataclass(frozen=True)
class EncodePayload:
    voice_id: str


class VoiceService:
    def __init__(
        self,
        *,
        db: Database,
        layout: DataLayout,
        clips: ClipStore,
        history: HistoryStore,
        host: EngineHost,
        jobs: JobManager,
        queue: SynthesisQueue,
        app_version: str,
    ) -> None:
        self._db = db
        self._layout = layout
        self._clips = clips
        self._history = history
        self._host = host
        self._jobs = jobs
        self._queue = queue
        self._app_version = app_version

    # --- Queries ------------------------------------------------------------------------

    def list(self) -> list[Voice]:
        rows = self._db.query("SELECT * FROM voices ORDER BY created_at DESC, id DESC")
        return [self._voice(row) for row in rows]

    def get(self, voice_id: str) -> Voice | None:
        if not is_id(voice_id):
            return None
        row = self._db.query_one("SELECT * FROM voices WHERE id = ?", (voice_id,))
        return None if row is None else self._voice(row)

    def require(self, voice_id: str) -> Voice:
        voice = self.get(voice_id)
        if voice is None:
            raise ApiError(ErrorCode.VOICE_NOT_FOUND, "voice not found", status_code=404)
        return voice

    def reference(self, voice_id: str) -> tuple[tuple[str, ...], Path | None]:
        """What a generation with this voice conditions on: its clips (in order), its
        embedding, or neither (a caption-only voice)."""
        voice = self.require(voice_id)
        if voice.consent_required and voice.consent is None:
            raise ApiError(ErrorCode.CONSENT_REQUIRED, "voice lacks consent", status_code=409)
        caps = self._host.spec.capabilities
        if voice.clips and not caps.speaker_reference:
            raise ApiError(ErrorCode.REFERENCE_UNSUPPORTED, "model has no reference input")
        if voice.embedding and not caps.speaker_embedding:
            raise ApiError(ErrorCode.REFERENCE_UNSUPPORTED, "model has no embedding input")
        embedding = self._embedding_path(voice_id) if voice.embedding else None
        return tuple(clip.clip_id for clip in voice.clips), embedding

    # --- Create / update / delete ---------------------------------------------------------

    def create(self, body: VoiceCreate) -> VoiceSaved:
        return self._saved(self._insert(body))

    def _insert(self, body: VoiceCreate) -> str:
        caps = self._host.spec.capabilities
        name = body.name.strip()
        if not name:
            raise ApiError(ErrorCode.VOICE_INVALID, "name is empty", status_code=422)
        clips = self._clips.check_assignable(None, body.clip_ids)
        if body.from_audio_id is not None and body.source != "designed":
            raise ApiError(ErrorCode.VOICE_INVALID, "only designed voices start from audio")
        if body.source == "embedding":
            if clips or not body.embedding_path:
                raise ApiError(ErrorCode.VOICE_INVALID, "an embedding voice needs one file")
        elif body.embedding_path:
            raise ApiError(ErrorCode.VOICE_INVALID, "only embedding voices take a file")
        if body.source in REAL_VOICE_SOURCES and not clips:
            raise ApiError(ErrorCode.VOICE_INVALID, "add at least one clip", status_code=422)
        caption_default = _text(body.caption_default)
        if (
            body.source == "designed"
            and not clips
            and body.from_audio_id is None
            and caption_default is None
        ):
            raise ApiError(ErrorCode.VOICE_INVALID, "a designed voice needs audio or a caption")
        if (clips or body.from_audio_id) and not caps.speaker_reference:
            raise ApiError(ErrorCode.REFERENCE_UNSUPPORTED, "model has no reference input")
        if body.embedding_path and not caps.speaker_embedding:
            raise ApiError(ErrorCode.REFERENCE_UNSUPPORTED, "model has no embedding input")
        needs_consent = body.source in REAL_VOICE_SOURCES or any(
            clip.origin in REAL_VOICE_ORIGINS for clip in clips
        )
        if needs_consent and body.consent is None:
            raise ApiError(ErrorCode.CONSENT_REQUIRED, "confirm consent", status_code=422)
        params_default = self._validated_params(body.params_default)
        lora_path = self._validated_lora(body.lora_path)
        embedding_source = self._validated_embedding(body.embedding_path)

        voice_id = new_id()
        folder = self._layout.voices / voice_id
        created: list[str] = []
        try:
            clip_ids = [clip.clip_id for clip in clips]
            if body.from_audio_id is not None:
                audio = self._history.audio_path(body.from_audio_id)
                if audio is None:
                    raise ApiError(ErrorCode.AUDIO_NOT_FOUND, "audio not found", status_code=404)
                clip = self._clips.add_file(audio, f"{name}.wav", origin="generated")
                created.append(clip.clip_id)
                clip_ids.insert(0, clip.clip_id)
            if embedding_source is not None:
                folder.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(embedding_source, folder / EMBEDDING_FILE)
            now = now_iso()
            consent = _consent(body.consent) if body.consent else None
            with self._db.transaction() as conn:
                conn.execute(
                    "INSERT INTO voices (id, name, source, created_at, updated_at, model_id,"
                    " caption_default, params_default_json, seed_default, lora_path, test_text,"
                    " design_caption, embedding_rel_path, consent_json)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        voice_id, name, body.source, now, now, self._host.spec.id,
                        caption_default, _dump(params_default), body.seed_default, lora_path,
                        _text(body.test_text), _text(body.design_caption),
                        self._layout.to_rel(folder / EMBEDDING_FILE) if embedding_source else None,
                        _dump(consent.model_dump()) if consent else None,
                    ),
                )  # fmt: skip
            self._clips.assign(voice_id, clip_ids)
        except BaseException:
            for clip_id in created:
                self._clips.delete(clip_id)
            remove_tree(folder)
            with self._db.transaction() as conn:
                conn.execute("DELETE FROM voices WHERE id = ?", (voice_id,))
            raise
        return voice_id

    def update(self, voice_id: str, body: VoicePatch) -> VoiceSaved:
        voice = self.require(voice_id)
        changes = body.model_fields_set
        columns: dict[str, Any] = {}
        if "name" in changes:
            name = (body.name or "").strip()
            if not name:
                raise ApiError(ErrorCode.VOICE_INVALID, "name is empty", status_code=422)
            columns["name"] = name
        if "caption_default" in changes:
            columns["caption_default"] = _text(body.caption_default)
        if "seed_default" in changes:
            columns["seed_default"] = body.seed_default
        if "test_text" in changes:
            columns["test_text"] = _text(body.test_text)
        if "lora_path" in changes:
            columns["lora_path"] = self._validated_lora(body.lora_path)
        if "params_default" in changes:
            columns["params_default_json"] = _dump(
                self._validated_params(body.params_default or SamplingParams())
            )
        consent = voice.consent
        if "consent" in changes and body.consent is not None:
            consent = _consent(body.consent)
            columns["consent_json"] = _dump(consent.model_dump())
        embedding_source = None
        if "embedding_path" in changes:
            if voice.source != "embedding" or not body.embedding_path:
                raise ApiError(ErrorCode.VOICE_INVALID, "only embedding voices take a file")
            embedding_source = self._validated_embedding(body.embedding_path)
        clip_ids = None
        if "clip_ids" in changes:
            if voice.source == "embedding" and body.clip_ids:
                raise ApiError(ErrorCode.VOICE_INVALID, "embedding voices have no clips")
            clip_ids = list(body.clip_ids or [])
            clips = self._clips.check_assignable(voice_id, clip_ids)
            if voice.source in REAL_VOICE_SOURCES and not clips:
                raise ApiError(ErrorCode.VOICE_INVALID, "keep at least one clip", status_code=422)
            needs_consent = voice.source in REAL_VOICE_SOURCES or any(
                clip.origin in REAL_VOICE_ORIGINS for clip in clips
            )
            if needs_consent and consent is None:
                raise ApiError(ErrorCode.CONSENT_REQUIRED, "confirm consent", status_code=422)

        if embedding_source is not None:
            folder = self._layout.voices / voice_id
            folder.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(embedding_source, folder / EMBEDDING_FILE)
        columns["updated_at"] = now_iso()
        with self._db.transaction() as conn:
            assignments = ", ".join(f"{column} = ?" for column in columns)
            conn.execute(
                f"UPDATE voices SET {assignments} WHERE id = ?", [*columns.values(), voice_id]
            )
        if clip_ids is not None:
            self._clips.assign(voice_id, clip_ids)
        return self._saved(voice_id)

    def delete(self, voice_id: str) -> bool:
        voice = self.get(voice_id)
        if voice is None:
            return False
        # A deleted voice takes its recordings with it (D13).
        for clip in voice.clips:
            self._clips.delete(clip.clip_id)
        with self._db.transaction() as conn:
            conn.execute("DELETE FROM voices WHERE id = ?", (voice_id,))
        remove_tree(self._layout.voices / voice_id)
        return True

    # --- Encoding ("encode on save") -----------------------------------------------------

    def enqueue_encode(self, voice_id: str) -> Job | None:
        voice = self.require(voice_id)
        if not voice.clips or voice.encoded:
            return None
        job = self._jobs.create("encode", "ui", EncodePayload(voice_id))
        self._queue.submit(job)
        return job

    def execute_encode(self, job: Job) -> None:
        payload: EncodePayload = job.payload
        if job.cancel_requested.is_set():
            job.mark_cancelled()
            return
        job.mark_started()
        try:
            backend = self._host.backend()
            voice = self.require(payload.voice_id)
            normalize_db, ensure_max = self._reference_settings(voice)
            _, encoded = self._clips.latents(
                [clip.clip_id for clip in voice.clips],
                backend=backend,
                spec=self._host.spec,
                options=self._host.options,
                normalize_db=normalize_db,
                ensure_max=ensure_max,
                on_log=lambda line: job.emit("log", line=line),
                on_encoded=lambda done, total: job.emit(
                    "progress", done=done, total=total, unit="clip"
                ),
            )
        except BackendError as exc:
            job.mark_failed(ErrorCode.parse(exc.code).value, exc.message)
            return
        except ApiError as exc:
            job.mark_failed(exc.code.value, exc.message)
            return
        except Exception as exc:
            log.exception("encode job %s failed", job.id)
            job.mark_failed(ErrorCode.SYNTHESIS_FAILED.value, f"{type(exc).__name__}: {exc}")
            return
        job.mark_completed({"voice_id": payload.voice_id, "encoded": encoded})

    # --- Packages (.irovoice, D22) --------------------------------------------------------

    def export(self, voice_id: str) -> tuple[str, bytes]:
        voice = self.require(voice_id)
        if voice.consent_required and voice.consent is None:
            raise ApiError(ErrorCode.CONSENT_REQUIRED, "voice lacks consent", status_code=409)
        buffer = io.BytesIO()
        manifest: dict[str, Any] = {
            "format": PACKAGE_FORMAT,
            "version": PACKAGE_VERSION,
            "app_version": self._app_version,
            "name": voice.name,
            "source": voice.source,
            "model_id": voice.model_id,
            "created_at": voice.created_at,
            "caption_default": voice.caption_default,
            "params_default": voice.params_default,
            "seed_default": voice.seed_default,
            "test_text": voice.test_text,
            "design_caption": voice.design_caption,
            "consent": voice.consent.model_dump() if voice.consent else None,
            "clips": [],
            "embedding": None,
        }
        with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
            for index, clip in enumerate(voice.clips, start=1):
                data, rate = sf.read(str(self._clips.audio_path(clip.clip_id)), dtype="float32")
                flac = io.BytesIO()
                sf.write(flac, data, rate, subtype="PCM_24", format="FLAC")
                name = f"clips/{index:02d}.flac"
                archive.writestr(name, flac.getvalue())
                manifest["clips"].append(
                    {"file": name, "filename": clip.filename, "origin": clip.origin}
                )
            if voice.embedding:
                archive.write(self._embedding_path(voice_id), EMBEDDING_FILE)
                manifest["embedding"] = EMBEDDING_FILE
            archive.writestr("voice.json", _dump(manifest, indent=2))
        safe = "".join(c for c in voice.name if c.isalnum() or c in " -_").strip() or "voice"
        return f"{safe}.irovoice", buffer.getvalue()

    def export_to(self, voice_id: str, path: str) -> ExportedFile:
        dest = Path(path)
        if not dest.is_absolute() or dest.is_dir():
            raise ApiError(ErrorCode.SAVE_PATH_INVALID, "destination must be an absolute file")
        if dest.suffix.lower() != ".irovoice":
            dest = dest.with_name(dest.name + ".irovoice")
        if not dest.parent.is_dir():
            raise ApiError(ErrorCode.SAVE_PATH_INVALID, "destination folder does not exist")
        _, data = self.export(voice_id)
        partial = dest.with_name(f".{dest.name}.part")
        try:
            partial.write_bytes(data)
            partial.replace(dest)
        except OSError as exc:
            partial.unlink(missing_ok=True)
            raise ApiError(ErrorCode.SAVE_FAILED, str(exc)) from exc
        return ExportedFile(path=str(dest), bytes=len(data))

    def import_package(self, stream: BinaryIO) -> VoiceSaved:
        data = stream.read(MAX_PACKAGE_BYTES + 1)
        if len(data) > MAX_PACKAGE_BYTES:
            raise ApiError(ErrorCode.PACKAGE_INVALID, "package is too large", status_code=413)
        try:
            archive = zipfile.ZipFile(io.BytesIO(data))
            manifest = json.loads(archive.read("voice.json").decode("utf-8"))
        except (zipfile.BadZipFile, KeyError, ValueError) as exc:
            raise ApiError(ErrorCode.PACKAGE_INVALID, "not a voice package") from exc
        if manifest.get("format") != PACKAGE_FORMAT or manifest.get("version") != PACKAGE_VERSION:
            raise ApiError(ErrorCode.PACKAGE_INVALID, "unsupported package version")
        source = manifest.get("source")
        entries = manifest.get("clips") or []
        consent = manifest.get("consent")
        origins = [str(entry.get("origin", "upload")) for entry in entries]
        if (source in REAL_VOICE_SOURCES or REAL_VOICE_ORIGINS & set(origins)) and not consent:
            raise ApiError(ErrorCode.CONSENT_REQUIRED, "package has no consent record")

        created: list[str] = []
        try:
            with tempfile.TemporaryDirectory() as tmp:
                for entry in entries:
                    member = _member(archive, entry.get("file"))
                    target = Path(tmp) / f"{len(created)}.flac"
                    target.write_bytes(archive.read(member))
                    origin = str(entry.get("origin", "upload"))
                    if origin not in ("upload", "recording", "generated"):
                        raise ApiError(ErrorCode.PACKAGE_INVALID, "unknown clip origin")
                    clip = self._clips.add_file(
                        target, str(entry.get("filename") or member), origin=origin
                    )
                    created.append(clip.clip_id)
                embedding_path = None
                if manifest.get("embedding"):
                    member = _member(archive, manifest["embedding"])
                    embedding_path = Path(tmp) / EMBEDDING_FILE
                    embedding_path.write_bytes(archive.read(member))
                known = {
                    k: v
                    for k, v in (manifest.get("params_default") or {}).items()
                    if k in param_table.NAMES
                }
                body = _package_body(
                    name=str(manifest.get("name") or "voice")[:100],
                    source=source,
                    clip_ids=created,
                    embedding_path=str(embedding_path) if embedding_path else None,
                    consent={
                        "statement": consent.get("statement", ""),
                        "locale": consent.get("locale", "ja"),
                    }
                    if isinstance(consent, dict)
                    else None,
                    caption_default=manifest.get("caption_default"),
                    params_default=SamplingParams(**known),
                    seed_default=manifest.get("seed_default"),
                    test_text=manifest.get("test_text"),
                    design_caption=manifest.get("design_caption"),
                )
                voice_id = self._insert(body)
        except BaseException:
            for clip_id in created:
                self._clips.delete(clip_id)
            raise
        # Keep the original consent record and model id (the package's provenance).
        try:
            record = _dump(Consent(**consent).model_dump()) if consent else None
        except (TypeError, ValidationError) as exc:
            self.delete(voice_id)
            raise ApiError(ErrorCode.PACKAGE_INVALID, "invalid consent record") from exc
        with self._db.transaction() as conn:
            conn.execute(
                "UPDATE voices SET consent_json = ?, model_id = ? WHERE id = ?",
                (record, str(manifest.get("model_id") or self._host.spec.id), voice_id),
            )
        return self._saved(voice_id)

    # --- Helpers --------------------------------------------------------------------------

    def _saved(self, voice_id: str) -> VoiceSaved:
        job = self.enqueue_encode(voice_id)
        return VoiceSaved(voice=self.require(voice_id), encode_job_id=job.id if job else None)

    def _voice(self, row: Any) -> Voice:
        clips = self._clips.for_voice(row["id"])
        consent = json.loads(row["consent_json"]) if row["consent_json"] else None
        voice = Voice(
            id=row["id"],
            name=row["name"],
            source=row["source"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            model_id=row["model_id"],
            caption_default=row["caption_default"],
            params_default=json.loads(row["params_default_json"] or "{}"),
            seed_default=row["seed_default"],
            lora_path=row["lora_path"],
            test_text=row["test_text"],
            design_caption=row["design_caption"],
            clips=clips,
            total_seconds=round(sum(clip.duration_s for clip in clips), 3),
            consent=Consent(**consent) if consent else None,
            consent_required=row["source"] in REAL_VOICE_SOURCES
            or any(clip.origin in REAL_VOICE_ORIGINS for clip in clips),
        )
        if row["embedding_rel_path"]:
            path = self._layout.from_rel(row["embedding_rel_path"])
            try:
                tokens, dim = inspect_embedding(path)
                voice.embedding = EmbeddingInfo(filename=path.name, tokens=tokens, dim=dim)
            except ApiError:
                voice.embedding = None
        voice.encoded = bool(clips) and self._encoded(voice)
        return voice

    def _encoded(self, voice: Voice) -> bool:
        normalize_db, ensure_max = self._reference_settings(voice)
        key = latent_key(self._host.spec, self._host.options, normalize_db, ensure_max)
        return all(self._clips.latent_path(c.clip_id, key).is_file() for c in voice.clips)

    def _reference_settings(self, voice: Voice) -> tuple[float | None, bool]:
        """Reference preprocessing the voice's generations use (its defaults, else the
        schema's), so encoding on save fills the cache those generations read."""
        caps = self._host.spec.capabilities
        try:
            values = param_table.resolve(
                voice.params_default, caps, reference_kind="voice", has_caption=False
            )
        except param_table.ParamError:
            values = param_table.resolve({}, caps, reference_kind="voice", has_caption=False)
        normalize_db = values.get("ref_normalize_db", -16.0)
        return normalize_db, bool(values.get("ref_ensure_max", True))  # type: ignore[return-value]

    def _validated_params(self, params: SamplingParams) -> dict[str, Any]:
        provided = params.model_dump(exclude_unset=True)
        provided.pop("seed", None)  # the voice's seed is `seed_default`
        try:
            param_table.resolve(
                provided,
                self._host.spec.capabilities,
                reference_kind="voice",
                has_caption=False,
            )
        except param_table.ParamError as exc:
            raise ApiError(
                ErrorCode.INVALID_PARAMS,
                str(exc),
                status_code=422,
                detail={"param": exc.name, "reason": exc.reason},
            ) from exc
        return provided

    @staticmethod
    def _validated_lora(path: str | None) -> str | None:
        path = _text(path)
        if path is None:
            return None
        lora = Path(path)
        if not (lora.is_absolute() and (lora / "adapter_config.json").is_file()):
            raise ApiError(ErrorCode.LORA_NOT_FOUND, "LoRA adapter directory not found")
        return str(lora)

    def _validated_embedding(self, path: str | None) -> Path | None:
        if not path:
            return None
        source = Path(path)
        if not (source.is_absolute() and source.is_file()):
            raise ApiError(ErrorCode.EMBEDDING_NOT_FOUND, "embedding file not found")
        inspect_embedding(source, expected_dim=self._host.speaker_dim)
        return source

    def _embedding_path(self, voice_id: str) -> Path:
        return self._layout.voices / voice_id / EMBEDDING_FILE


def inspect_embedding(path: Path, *, expected_dim: int | None = None) -> tuple[int, int]:
    """(tokens, dim) of a Speaker Inversion file, read from the safetensors header (no
    tensor library needed). Raises `embedding_invalid`. The shape must be (tokens, dim):
    upstream's inference path takes the tensor as saved, without squeezing a batch axis."""

    def invalid(reason: str, **detail: object) -> ApiError:
        return ApiError(
            ErrorCode.EMBEDDING_INVALID,
            f"not a speaker embedding: {reason}",
            status_code=422,
            detail={"reason": reason, **detail},
        )

    try:
        with path.open("rb") as handle:
            (size,) = struct.unpack("<Q", handle.read(8))
            if size <= 0 or size > 16 * 1024 * 1024:
                raise invalid("header")
            header = json.loads(handle.read(size).decode("utf-8"))
    except (OSError, struct.error, UnicodeDecodeError, ValueError) as exc:
        raise invalid("header") from exc
    entry = header.get(EMBEDDING_KEY) if isinstance(header, dict) else None
    if not isinstance(entry, dict):
        raise invalid("missing_key")
    if entry.get("dtype") not in EMBEDDING_DTYPES:
        raise invalid("dtype", dtype=entry.get("dtype"))
    shape = list(entry.get("shape") or [])
    if len(shape) != 2 or int(shape[0]) <= 0 or int(shape[1]) <= 0:
        raise invalid("shape", shape=shape)
    tokens, dim = int(shape[0]), int(shape[1])
    if expected_dim is not None and dim != expected_dim:
        raise invalid("dim", expected=expected_dim, actual=dim)
    return tokens, dim


def _member(archive: zipfile.ZipFile, name: object) -> str:
    """A safe entry name that exists in the archive (no absolute or parent paths)."""
    if not isinstance(name, str):
        raise ApiError(ErrorCode.PACKAGE_INVALID, "missing file entry")
    parts = PurePosixPath(name).parts
    if not parts or name.startswith("/") or any(p in ("", ".", "..") for p in parts):
        raise ApiError(ErrorCode.PACKAGE_INVALID, "unsafe file entry")
    if name not in archive.namelist():
        raise ApiError(ErrorCode.PACKAGE_INVALID, "file entry missing from package")
    return name


def _package_body(**fields: Any) -> VoiceCreate:
    try:
        return VoiceCreate(**fields)
    except ValidationError as exc:
        raise ApiError(ErrorCode.PACKAGE_INVALID, "invalid voice.json") from exc


def _consent(consent: ConsentInput) -> Consent:
    return Consent(
        confirmed_at=now_iso(),
        statement=consent.statement.strip(),
        locale=consent.locale,
        version=CONSENT_VERSION,
    )


def _text(value: str | None) -> str | None:
    if value is None:
        return None
    value = value.strip()
    return value or None


def _dump(value: object, *, indent: int | None = None) -> str:
    return json.dumps(value, ensure_ascii=False, indent=indent)
