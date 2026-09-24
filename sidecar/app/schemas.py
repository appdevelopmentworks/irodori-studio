"""Pydantic request/response models mirroring docs/api-spec.md.

Keep in sync with the spec and with src/lib/types.ts in the same change.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    SerializerFunctionWrapHandler,
    model_serializer,
)

Device = Literal["cuda", "mps", "cpu"]
Precision = Literal["fp32", "bf16"]


class ErrorResponse(BaseModel):
    code: str
    message: str
    detail: dict[str, object] = {}


# --- System ----------------------------------------------------------------------------


class RuntimeInfo(BaseModel):
    """Runtime options of the resident model (change requires a reload, D4)."""

    device: Device
    model_precision: Precision
    codec_device: Device
    codec_precision: Precision
    compile_model: bool
    compile_dynamic: bool


class EngineStatus(BaseModel):
    state: Literal["idle", "loading", "ready", "error"]
    model_id: str | None = None
    error_code: str | None = None
    runtime: RuntimeInfo | None = None


class HealthResponse(BaseModel):
    status: Literal["ok"] = "ok"
    engine: EngineStatus


class TorchInfo(BaseModel):
    version: str
    cuda_version: str | None = None
    cuda_available: bool
    mps_available: bool


class DeviceInfo(BaseModel):
    kind: Device
    precision: Precision
    available: bool
    name: str | None = None
    compute_capability: str | None = None
    memory_total_mb: int | None = None
    memory_used_mb: int | None = None


class SystemInfo(BaseModel):
    app_version: str
    python_version: str
    platform: Literal["windows", "macos", "linux", "other"]
    device: DeviceInfo
    torch: TorchInfo | None = None
    upstream_commit: str | None = None
    active_model: str | None = None
    queue_length: int = 0
    watermark_available: bool | None = None
    # ffmpeg is available: other audio formats can be read and saved (D20).
    ffmpeg_available: bool = False
    issues: list[str] = []


# --- Models ----------------------------------------------------------------------------


class Capabilities(BaseModel):
    caption: bool
    speaker_reference: bool
    speaker_embedding: bool
    lora: bool
    duration_predictor: bool
    max_ref_seconds: float
    max_output_seconds: float
    sampling: Literal["rf", "meanflow"]
    ignores: list[str]


class ModelInfo(BaseModel):
    id: str
    display_name: str
    tier: str
    size_bytes_approx: int
    installed: bool
    active: bool
    capabilities: Capabilities


class ParamSchema(BaseModel):
    name: str
    type: Literal["int", "float", "bool", "enum"]
    default: int | float | bool | str | None
    nullable: bool
    min: float | None = None
    max: float | None = None
    step: float | None = None
    choices: list[str] | None = None
    group: Literal["sampling", "duration", "cfg", "speaker", "reference", "advanced"]
    tier: Literal["simple", "advanced"]
    visible_when: dict[str, list[str | bool]] | None = None


class Limits(BaseModel):
    max_candidates: int
    max_text_chars: int
    max_caption_chars: int
    max_clips: int
    max_clip_seconds: float
    max_upload_bytes: int


class ModelCapabilities(BaseModel):
    model_id: str
    display_name: str
    capabilities: Capabilities
    params: list[ParamSchema]
    limits: Limits


class EmojiItem(BaseModel):
    symbol: str
    key: str  # stable id for i18n (`emoji.<key>`), derived from the code points
    label_ja: str  # upstream's Japanese label and description (source data)
    description_ja: str


# --- Generation ------------------------------------------------------------------------


class ReferenceNone(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["none"] = "none"


class ReferenceVoice(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["voice"]
    voice_id: str


class ReferenceClips(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["clips"]
    clip_ids: list[str] = Field(min_length=1, max_length=32)


class ReferenceEmbedding(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["embedding"]
    path: str


ReferenceInput = Annotated[
    ReferenceNone | ReferenceVoice | ReferenceClips | ReferenceEmbedding,
    Field(discriminator="kind"),
]


class SamplingParams(BaseModel):
    """All optional: omitted = the capability default; `null` = auto/off where allowed.

    Types are loose on purpose; ranges and choices are checked against the single
    parameter table (`engine/params.py`), which also drives the UI.
    """

    model_config = ConfigDict(extra="forbid")

    num_steps: int | None = None
    num_candidates: int | None = None
    seed: int | None = None
    t_schedule_mode: str | None = None
    sway_coeff: float | None = None
    truncation_factor: float | None = None
    rescale_k: float | None = None
    rescale_sigma: float | None = None
    context_kv_cache: bool | None = None
    seconds: float | None = None
    duration_scale: float | None = None
    cfg_guidance_mode: str | None = None
    cfg_scale_text: float | None = None
    cfg_scale_caption: float | None = None
    cfg_scale_speaker: float | None = None
    cfg_scale: float | None = None
    cfg_min_t: float | None = None
    cfg_max_t: float | None = None
    speaker_kv_scale: float | None = None
    speaker_kv_min_t: float | None = None
    speaker_kv_max_layers: int | None = None
    speaker_uncond_mode: str | None = None
    ref_normalize_db: float | None = None
    ref_ensure_max: bool | None = None
    max_ref_seconds: float | None = None
    max_text_len: int | None = None
    max_caption_len: int | None = None
    decode_mode: str | None = None
    trim_tail: bool | None = None
    tail_window_size: int | None = None
    tail_std_threshold: float | None = None
    tail_mean_threshold: float | None = None

    @model_serializer(mode="wrap")
    def _given_only(self, handler: SerializerFunctionWrapHandler) -> dict[str, Any]:
        """Only the values that were given: omitted means the default while `null` means
        auto/off, so an omitted value must not come back as `null`."""
        data = handler(self)
        return {name: value for name, value in data.items() if name in self.model_fields_set}


class SynthesisRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    text: str
    caption: str | None = None
    reference: ReferenceInput = Field(default_factory=ReferenceNone)
    lora_adapter: str | None = None
    params: SamplingParams = Field(default_factory=SamplingParams)
    # The user dictionary (D19) rewrites the text before it reaches the model.
    apply_dictionary: bool = True


class JobAccepted(BaseModel):
    job_id: str
    queue_position: int


JobState = Literal["queued", "running", "completed", "failed", "cancelled"]


class AudioOutput(BaseModel):
    index: int
    audio_id: str
    duration_s: float


class TtsResult(BaseModel):
    history_id: str
    used_seed: int
    timings: dict[str, float]
    outputs: list[AudioOutput]
    watermarked: bool


class EncodeResult(BaseModel):
    voice_id: str
    encoded: int


class NarrationResult(BaseModel):
    narration_id: str
    rendered: int


class ScriptResult(BaseModel):
    script_id: str
    rendered: int


class JobError(BaseModel):
    code: str
    message: str


JobKind = Literal["tts", "encode", "narration", "script"]


class JobInfo(BaseModel):
    job_id: str
    kind: JobKind
    state: JobState
    queue_position: int | None = None
    created_at: str
    started_at: str | None = None
    finished_at: str | None = None
    error: JobError | None = None
    result: TtsResult | EncodeResult | NarrationResult | ScriptResult | None = None


class CancelResponse(BaseModel):
    job_id: str
    state: Literal["cancelled", "cancelling", "completed", "failed"]


class QueueItem(BaseModel):
    job_id: str
    kind: JobKind
    source: Literal["ui", "api"]
    state: Literal["queued", "running"]
    created_at: str


class QueueSnapshot(BaseModel):
    running: QueueItem | None = None
    queued: list[QueueItem] = []


# --- Clips -----------------------------------------------------------------------------


ClipOrigin = Literal["upload", "recording", "generated"]


class ClipInfo(BaseModel):
    clip_id: str
    filename: str
    duration_s: float
    sample_rate: int
    channels: int
    created_at: str
    # Uploaded and recorded audio may be a real person's voice (consent, D13).
    origin: ClipOrigin = "upload"
    voice_id: str | None = None  # the library voice that owns the clip


class TrimRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    start_s: float = Field(ge=0)
    end_s: float = Field(gt=0)


class SplitRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    at_s: list[float] = Field(min_length=1, max_length=31)


# --- Voices (Session 4) ----------------------------------------------------------------

VoiceSource = Literal["designed", "imported", "recorded", "embedding"]
ParamValue = int | float | bool | str | None


class ConsentInput(BaseModel):
    """The statement the user confirmed, in the words and language they saw (D13)."""

    model_config = ConfigDict(extra="forbid")

    statement: str = Field(min_length=10, max_length=2000)
    locale: str = Field(min_length=2, max_length=20)


class Consent(BaseModel):
    confirmed_at: str
    statement: str
    locale: str
    version: int = 1


class EmbeddingInfo(BaseModel):
    filename: str
    tokens: int
    dim: int


class Voice(BaseModel):
    id: str
    name: str
    source: VoiceSource
    created_at: str
    updated_at: str
    model_id: str
    caption_default: str | None = None
    params_default: dict[str, ParamValue] = {}
    seed_default: int | None = None
    lora_path: str | None = None
    test_text: str | None = None
    design_caption: str | None = None
    clips: list[ClipInfo] = []
    total_seconds: float = 0.0
    embedding: EmbeddingInfo | None = None
    consent: Consent | None = None
    # Real-voice audio (uploaded or recorded) needs recorded consent (D13).
    consent_required: bool = False
    # Reference latents are cached for the active model (Session 4, "encode on save").
    encoded: bool = False


class VoiceCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=100)
    source: VoiceSource
    clip_ids: list[str] = Field(default_factory=list, max_length=32)
    # designed: keep this generated candidate (GET /audio/{id}) as the voice's clip.
    from_audio_id: str | None = None
    # embedding: absolute path of a `.speaker.safetensors` to copy into the library.
    embedding_path: str | None = None
    consent: ConsentInput | None = None
    caption_default: str | None = Field(default=None, max_length=1000)
    params_default: SamplingParams = Field(default_factory=SamplingParams)
    seed_default: int | None = Field(default=None, ge=0, le=2**53 - 1)
    lora_path: str | None = None
    test_text: str | None = Field(default=None, max_length=2000)
    design_caption: str | None = Field(default=None, max_length=1000)


class VoicePatch(BaseModel):
    """Partial update: only the fields sent change (`null` clears a nullable field)."""

    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, min_length=1, max_length=100)
    clip_ids: list[str] | None = Field(default=None, max_length=32)
    embedding_path: str | None = None
    consent: ConsentInput | None = None
    caption_default: str | None = Field(default=None, max_length=1000)
    params_default: SamplingParams | None = None
    seed_default: int | None = Field(default=None, ge=0, le=2**53 - 1)
    lora_path: str | None = None
    test_text: str | None = Field(default=None, max_length=2000)


class ExportRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    path: str  # absolute destination from the native save dialog


class ExportedFile(BaseModel):
    path: str
    bytes: int


class VoiceSaved(BaseModel):
    voice: Voice
    # Encoding the voice's clips for the active model (a queued job), when needed.
    encode_job_id: str | None = None


# --- History ---------------------------------------------------------------------------


class HistorySummary(BaseModel):
    id: str
    created_at: str
    model_id: str
    text: str
    caption: str | None = None
    reference_kind: str
    used_seed: int
    watermarked: bool
    outputs: list[AudioOutput]
    # The candidate the user adopted (requirements §6.3), if any.
    adopted_audio_id: str | None = None
    # The library voice of a `{kind: "voice"}` request.
    voice_id: str | None = None


class HistoryPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    adopted_audio_id: str | None


AudioFormat = Literal["wav", "mp3", "m4a", "flac", "opus"]
SampleRate = Literal[48000, 44100]
LoudnessTarget = Literal[-14, -16, -23]


class PostOptions(BaseModel):
    """Post-processing for exports (D20); the defaults change nothing."""

    model_config = ConfigDict(extra="forbid")

    sample_rate: SampleRate = 48000  # Opus stays at 48 kHz
    loudness: LoudnessTarget | None = None  # integrated LUFS target (EBU R128), or off
    tempo: float = Field(default=1.0, ge=0.5, le=2.0)  # time stretch, pitch kept
    gain_db: float = Field(default=0.0, ge=-20.0, le=20.0)  # only when loudness is off


class OutputOptions(PostOptions):
    """Export settings the screens share (kept in preferences)."""

    format: AudioFormat = "wav"


class SaveAudioRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    path: str  # absolute destination, normally from the native save dialog
    # None: from the path's extension, else WAV. Formats other than WAV need ffmpeg.
    format: AudioFormat | None = None
    post: PostOptions | None = None


class SavedFile(BaseModel):
    path: str
    bytes: int
    format: AudioFormat


class HistoryEntry(HistorySummary):
    request: dict[str, object]
    params: dict[str, object]
    timings: dict[str, float]
    messages: list[str]
    device: str
    precision: str


class HistoryPage(BaseModel):
    items: list[HistorySummary]
    total: int


class HistoryUsage(BaseModel):
    entries: int
    bytes: int


class RegenerateRequest(BaseModel):
    """The entry's request again. `seed` omitted: its used seed (the same request);
    `null`: a new random seed."""

    model_config = ConfigDict(extra="forbid")

    seed: int | None = Field(default=None, ge=0, le=2**53 - 1)
    num_candidates: int | None = Field(default=None, ge=1, le=32)


class HistoryExportRequest(BaseModel):
    """Each entry's adopted candidate (else its first) into a folder."""

    model_config = ConfigDict(extra="forbid")

    history_ids: list[str] = Field(min_length=1, max_length=1000)
    folder: str  # absolute, from the native folder dialog
    format: AudioFormat = "wav"
    post: PostOptions | None = None
    # {date} 20260925-143000 (local time), {n} 1, {index} 001, {text_head}, {seed}, {id}
    naming_template: str = Field(default="{date}_{text_head}", max_length=200)


class HistoryExported(BaseModel):
    files: list[ExportedFile]


# --- Text: user dictionary and reading preview (D19) ----------------------------------


class DictionaryEntryInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    surface: str = Field(min_length=1, max_length=64)  # as written in the text
    reading: str = Field(min_length=1, max_length=128)  # what the model is given instead
    enabled: bool = True
    note: str | None = Field(default=None, max_length=200)


class DictionaryEntry(DictionaryEntryInput):
    id: str


class ReadingRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    text: str = Field(max_length=20_000)
    apply_dictionary: bool = True


class ReadingToken(BaseModel):
    surface: str
    reading: str  # estimated katakana (a hint, not what the model will say)
    moras: int
    source: Literal["analyzer", "dictionary", "symbol", "text"]


class ReadingResult(BaseModel):
    tokens: list[ReadingToken]
    moras: int
    estimated_seconds: float
    analyzer: bool  # false: no analyzer available, tokens are plain text


# --- Narration (Session 5, D18) ---------------------------------------------------------

NarrationFormat = Literal["text", "markdown", "srt"]
PauseKind = Literal["clause", "sentence", "paragraph", "cue"]


class SplitRules(BaseModel):
    model_config = ConfigDict(extra="forbid")

    min_chars: int = Field(default=80, ge=1, le=400)  # 1: one sentence per chunk
    max_chars: int = Field(default=150, ge=20, le=400)


class Pauses(BaseModel):
    model_config = ConfigDict(extra="forbid")

    sentence_ms: int = Field(default=400, ge=0, le=5000)
    paragraph_ms: int = Field(default=900, ge=0, le=10_000)


class NarrationSettings(BaseModel):
    """How every chunk is generated. The reference and caption follow SynthesisRequest;
    the client applies a library voice's defaults, as on the Quick screen."""

    model_config = ConfigDict(extra="forbid")

    reference: ReferenceInput = Field(default_factory=ReferenceNone)
    caption: str | None = Field(default=None, max_length=1000)
    lora_adapter: str | None = None
    params: SamplingParams = Field(default_factory=SamplingParams)
    pauses: Pauses = Field(default_factory=Pauses)
    # D18: without speaker audio, chunk 1's take becomes the reference for the others.
    voice_lock: bool = True
    apply_dictionary: bool = True


class Cue(BaseModel):
    start_ms: int
    end_ms: int


class SubtitleCue(Cue):
    index: int
    text: str


class Take(BaseModel):
    """A generated take of a narration chunk or a script line."""

    audio_id: str
    duration_s: float
    seed: int
    truncated: bool  # the take hit the output limit; the chunk text may be cut off
    created_at: str


class NarrationChunk(BaseModel):
    index: int
    text: str
    pause_after: PauseKind
    estimated_seconds: float
    cue: Cue | None = None  # SRT input: the cue this chunk must fit
    takes: list[Take] = []
    adopted_audio_id: str | None = None


class NarrationWarning(BaseModel):
    code: Literal["cue_too_long", "cue_overlap", "chunk_too_long"]
    index: int


class AssembledNarration(BaseModel):
    audio_id: str
    duration_s: float
    cues: list[SubtitleCue]


class Narration(BaseModel):
    id: str
    title: str
    created_at: str
    updated_at: str
    format: NarrationFormat
    source: str
    rules: SplitRules
    settings: NarrationSettings
    chunks: list[NarrationChunk]
    warnings: list[NarrationWarning] = []
    assembled: AssembledNarration | None = None
    analyzer: bool  # estimates come from mora counts (true) or characters
    render_job_id: str | None = None  # the render job queued or running, to follow


class NarrationSummary(BaseModel):
    id: str
    title: str
    created_at: str
    updated_at: str
    format: NarrationFormat
    chunks: int
    rendered: int


class NarrationCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str | None = Field(default=None, max_length=100)
    source: str = Field(min_length=1, max_length=200_000)
    format: NarrationFormat = "text"
    rules: SplitRules = Field(default_factory=SplitRules)
    settings: NarrationSettings = Field(default_factory=NarrationSettings)


class NarrationPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str | None = Field(default=None, min_length=1, max_length=100)
    settings: NarrationSettings | None = None


class NarrationSplit(BaseModel):
    """Split again (new manuscript or rules): every take is discarded."""

    model_config = ConfigDict(extra="forbid")

    source: str = Field(min_length=1, max_length=200_000)
    format: NarrationFormat = "text"
    rules: SplitRules = Field(default_factory=SplitRules)


class ChunkPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    text: str | None = Field(default=None, min_length=1, max_length=1000)
    adopted_audio_id: str | None = None


class RenderRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # Chunks to render; omitted = every chunk without an adopted take (resume).
    indices: list[int] | None = Field(default=None, max_length=5000)
    # Render chunks that already have takes too (a new take is added and adopted).
    redo: bool = False
    num_candidates: int | None = Field(default=None, ge=1, le=8)


class NarrationExportRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    path: str  # absolute, from the native save dialog
    format: AudioFormat = "wav"
    subtitles: list[Literal["srt", "vtt"]] = Field(default_factory=lambda: ["srt"])
    per_chunk: bool = False
    post: PostOptions | None = None  # subtitles follow a changed tempo


class NarrationExported(BaseModel):
    files: list[ExportedFile]


# --- Scripts (Session 6) -----------------------------------------------------------------

ScriptFormat = Literal["text", "csv", "tsv"]


class ScriptSpeaker(BaseModel):
    """Who says a line: a library voice (its defaults apply) or none, plus a caption for
    all of the speaker's lines (a line's own caption wins)."""

    model_config = ConfigDict(extra="forbid")

    name: str = Field(max_length=32)
    voice_id: str | None = None
    caption: str | None = Field(default=None, max_length=1000)


class ScriptSettings(BaseModel):
    model_config = ConfigDict(extra="forbid")

    params: SamplingParams = Field(default_factory=SamplingParams)  # for every line
    pause_ms: int = Field(default=500, ge=0, le=10_000)  # after a line, unless it says otherwise
    # Per-line file names: {index} 001, {n} 1, {speaker}, {text_head}, {title}, {id}.
    naming_template: str = Field(default="{index}_{speaker}_{text_head}", max_length=200)
    subtitle_speakers: bool = True  # "話者：セリフ" in the subtitles
    apply_dictionary: bool = True


class ScriptLineInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    speaker: str = Field(default="", max_length=32)
    text: str = Field(min_length=1, max_length=1000)
    caption: str | None = Field(default=None, max_length=1000)
    num_candidates: int | None = Field(default=None, ge=1, le=32)
    seed: int | None = Field(default=None, ge=0, le=2**53 - 1)
    pause_ms: int | None = Field(default=None, ge=0, le=10_000)
    file_name: str | None = Field(default=None, max_length=120)  # instead of the template


class ScriptLine(ScriptLineInput):
    id: str
    index: int
    takes: list[Take] = []
    adopted_audio_id: str | None = None


class ScriptCue(SubtitleCue):
    line_id: str
    speaker: str


class AssembledScript(BaseModel):
    audio_id: str
    duration_s: float
    cues: list[ScriptCue]


class Script(BaseModel):
    id: str
    title: str
    created_at: str
    updated_at: str
    speakers: list[ScriptSpeaker]
    settings: ScriptSettings
    lines: list[ScriptLine]
    assembled: AssembledScript | None = None
    render_job_id: str | None = None


class ScriptSummary(BaseModel):
    id: str
    title: str
    created_at: str
    updated_at: str
    lines: int
    rendered: int
    speakers: int


class ScriptCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str | None = Field(default=None, max_length=100)
    source: str = Field(min_length=1, max_length=500_000)
    format: ScriptFormat = "text"
    settings: ScriptSettings = Field(default_factory=ScriptSettings)


class ScriptImport(BaseModel):
    """More lines from text or a table: replacing every line (their takes are discarded)
    or appended at the end."""

    model_config = ConfigDict(extra="forbid")

    source: str = Field(min_length=1, max_length=500_000)
    format: ScriptFormat = "text"
    mode: Literal["replace", "append"] = "replace"


class ScriptPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str | None = Field(default=None, min_length=1, max_length=100)
    settings: ScriptSettings | None = None
    speakers: list[ScriptSpeaker] | None = Field(default=None, max_length=200)


class LinePatch(BaseModel):
    """Only the fields sent change (`null` clears). New text or another speaker discards
    the line's takes."""

    model_config = ConfigDict(extra="forbid")

    speaker: str | None = Field(default=None, max_length=32)
    text: str | None = Field(default=None, min_length=1, max_length=1000)
    caption: str | None = Field(default=None, max_length=1000)
    num_candidates: int | None = Field(default=None, ge=1, le=32)
    seed: int | None = Field(default=None, ge=0, le=2**53 - 1)
    pause_ms: int | None = Field(default=None, ge=0, le=10_000)
    file_name: str | None = Field(default=None, max_length=120)
    adopted_audio_id: str | None = None


class LineInsert(BaseModel):
    model_config = ConfigDict(extra="forbid")

    line: ScriptLineInput
    position: int | None = Field(default=None, ge=0)  # omitted: at the end


class LineMove(BaseModel):
    model_config = ConfigDict(extra="forbid")

    position: int = Field(ge=0)


class ScriptRenderRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # Lines to render; omitted = every line without an adopted take (resume).
    line_ids: list[str] | None = Field(default=None, max_length=5000)
    redo: bool = False
    num_candidates: int | None = Field(default=None, ge=1, le=32)


class ScriptExportRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    folder: str  # absolute, from the native folder dialog
    format: AudioFormat = "wav"
    per_line: bool = True
    merged: bool = True
    subtitles: list[Literal["srt", "vtt"]] = Field(default_factory=lambda: ["srt"])
    post: PostOptions | None = None  # subtitles follow a changed tempo


class ScriptTableRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    path: str  # absolute, from the native save dialog
    format: Literal["csv", "tsv"] = "csv"


class ScriptExported(BaseModel):
    files: list[ExportedFile]


class FileNamesRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    naming_template: str = Field(max_length=200)


class FileNames(BaseModel):
    names: list[str]  # per line, without the extension


# --- Preferences -----------------------------------------------------------------------


class Preferences(BaseModel):
    watermark_enabled: bool = True
    history_max_entries: int = Field(default=500, ge=1, le=100_000)
    history_max_bytes: int = Field(default=5_000_000_000, ge=10_000_000)
    output: OutputOptions = Field(default_factory=OutputOptions)


class PreferencesPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    watermark_enabled: bool | None = None
    history_max_entries: int | None = Field(default=None, ge=1, le=100_000)
    history_max_bytes: int | None = Field(default=None, ge=10_000_000)
    output: OutputOptions | None = None


# --- Presets (Session 7) -----------------------------------------------------------------


class PresetInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=60)
    params: SamplingParams = Field(default_factory=SamplingParams)


class Preset(PresetInput):
    id: str
    created_at: str
    updated_at: str


class PresetPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, min_length=1, max_length=60)
    params: SamplingParams | None = None


# --- Projects (Session 7, D23) -----------------------------------------------------------

ProjectKind = Literal["narration", "script"]


class ProjectSaveRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: ProjectKind
    id: str
    path: str  # absolute, from the native save dialog; `.iroproj` is applied


class ProjectOpenRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    path: str  # absolute `.iroproj`, from the native open dialog


class ProjectOpened(BaseModel):
    """The narration or script created from a project. Library voices and LoRA
    adapters it used that are not here are dropped (listed by name / path)."""

    kind: ProjectKind
    id: str
    missing_voices: list[str] = []
    missing_lora: list[str] = []
