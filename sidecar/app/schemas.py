"""Pydantic request/response models mirroring docs/api-spec.md.

Keep in sync with the spec and with src/lib/types.ts in the same change.
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field

Device = Literal["cuda", "mps", "cpu"]
Precision = Literal["fp32", "bf16"]


class ErrorResponse(BaseModel):
    code: str
    message: str
    detail: dict[str, object] = {}


# --- System ----------------------------------------------------------------------------


class EngineStatus(BaseModel):
    state: Literal["idle", "loading", "ready", "error"]
    model_id: str | None = None
    error_code: str | None = None


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


class SynthesisRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    text: str
    caption: str | None = None
    reference: ReferenceInput = Field(default_factory=ReferenceNone)
    lora_adapter: str | None = None
    params: SamplingParams = Field(default_factory=SamplingParams)
    # User dictionary (D19, Session 5); accepted now so clients need not change later.
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


class JobError(BaseModel):
    code: str
    message: str


class JobInfo(BaseModel):
    job_id: str
    kind: Literal["tts"]
    state: JobState
    queue_position: int | None = None
    created_at: str
    started_at: str | None = None
    finished_at: str | None = None
    error: JobError | None = None
    result: TtsResult | None = None


class CancelResponse(BaseModel):
    job_id: str
    state: Literal["cancelled", "cancelling", "completed", "failed"]


class QueueItem(BaseModel):
    job_id: str
    kind: Literal["tts"]
    source: Literal["ui", "api"]
    state: Literal["queued", "running"]
    created_at: str


class QueueSnapshot(BaseModel):
    running: QueueItem | None = None
    queued: list[QueueItem] = []


# --- Clips -----------------------------------------------------------------------------


class ClipInfo(BaseModel):
    clip_id: str
    filename: str
    duration_s: float
    sample_rate: int
    channels: int
    created_at: str


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


# --- Preferences -----------------------------------------------------------------------


class Preferences(BaseModel):
    watermark_enabled: bool = True
    history_max_entries: int = Field(default=500, ge=1, le=100_000)
    history_max_bytes: int = Field(default=5_000_000_000, ge=10_000_000)


class PreferencesPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    watermark_enabled: bool | None = None
    history_max_entries: int | None = Field(default=None, ge=1, le=100_000)
    history_max_bytes: int | None = Field(default=None, ge=10_000_000)
