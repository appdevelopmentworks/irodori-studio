# API specification

Single source of truth for the sidecar HTTP contracts. Keep these three in sync in the same change: this file, `src/lib/types.ts`, `sidecar/app/schemas.py` (see `coding-conventions.md`).

Two listeners (D21):
- **Internal API** — `http://127.0.0.1:<random>`; used only by the app UI. No auth (localhost, random port).
- **External API** — optional; `<bind>:<port>` (default `127.0.0.1:50221`); OpenAI- and VOICEVOX-compatible routes for other apps. An API key (`Authorization: Bearer` or `X-API-Key`) is required for a LAN bind and optional on this computer.

Status of this document: **v0 draft**. Shapes below are the intended contract; refine field-by-field during the session that implements each router and update this file in the same change. Implemented so far: system (S1); models, generation & jobs, clips, basic history and preferences (S2); engine runtime in `/health`, adopting a candidate and saving a copy (S3); clip editing and the voice library with encode jobs and `.irovoice` packages (S4); the user dictionary, reading preview and narrations (S5); scripts (S6); output post-processing, the library, presets and projects (S7); the API server with its OpenAI- and VOICEVOX-compatible routes (S8).

---

## Conventions

- JSON, UTF-8, `snake_case`.
- Errors: HTTP 4xx/5xx with body `{"code": "string", "message": "string", "detail": {}}`. `code` values are stable and listed in `sidecar/app/errors.py`; the frontend translates them (`message` is a developer hint, never UI copy). Status classes: 400 unsupported or missing inputs, 404 unknown ids, 413 too long / too large, 415 unreadable audio, 422 validation (`invalid_request` for malformed bodies with `detail.errors`, `invalid_params` with `detail {param, reason}`, `text_empty`, `text_too_long` with `detail {field, max_chars}`), 500 `internal_error`.
- Long-running operations return `202 {"job_id": "...", "queue_position": 0}`; follow with SSE.
- IDs are ULIDs (sortable). Timestamps are ISO 8601 UTC (`2026-09-24T02:26:57.752Z`).
- Seeds are integers in `0 … 2^53−1` so they survive JavaScript numbers.

## Common types

```ts
type ReferenceInput =
  | { kind: "none" }                               // default: no speaker reference
  | { kind: "voice"; voice_id: string }            // library voice: its clips (cached latents) or embedding; 409 consent_required without consent
  | { kind: "clips"; clip_ids: string[] }          // 1–32 clips from POST /clips, concatenated in order
  | { kind: "embedding"; path: string };           // absolute path to a .speaker.safetensors

// Names mirror upstream SamplingRequest. Every field is optional: omitted = the model's
// default (HF Space values, D26); `null` = auto/off where nullable. Ranges, groups, tiers
// and visibility are served by GET /models/active/capabilities (engine/params.py).
// Responses carry only the fields that were given: an omitted field never comes back as `null`.
type SamplingParams = {
  num_steps?: number;               // 1–120, default 40
  num_candidates?: number;          // 1–32, default 1
  seed?: number | null;             // 0–2^53−1; null = random (the used seed is reported)
  t_schedule_mode?: "linear" | "sway";
  sway_coeff?: number;              // -1.0–1.5, default -1.0 (only when sway)
  truncation_factor?: number | null; // 0.05–2.0
  rescale_k?: number | null;        // 0.01–10, set together with rescale_sigma
  rescale_sigma?: number | null;    // 0.01–10
  context_kv_cache?: boolean;       // default true
  seconds?: number | null;          // 0.5–max_output_seconds; null = duration predictor
  duration_scale?: number;          // 0.5–1.5, default 1.0
  cfg_guidance_mode?: "independent" | "joint" | "alternating"; // joint needs equal enabled scales
  cfg_scale_text?: number;          // 0–10, default 3.0
  cfg_scale_caption?: number;       // 0–10, default 4.0 (Space)
  cfg_scale_speaker?: number;       // 0–10, default 5.0
  cfg_scale?: number | null;        // deprecated shared override
  cfg_min_t?: number;               // 0–1, default 0.5 (≤ cfg_max_t)
  cfg_max_t?: number;               // 0–1, default 1.0
  speaker_kv_scale?: number | null; // 0.1–5.0
  speaker_kv_min_t?: number | null; // 0–1, default 0.9
  speaker_kv_max_layers?: number | null; // 0–64
  speaker_uncond_mode?: "mask" | "noise"; // embedding only
  ref_normalize_db?: number | null; // -40–0, default -16.0; null = off
  ref_ensure_max?: boolean;         // default true
  max_ref_seconds?: number | null;  // 1–max_ref_seconds; null = checkpoint (120)
  max_text_len?: number | null;     // 16–1024; null = checkpoint
  max_caption_len?: number | null;  // 16–1024; null = checkpoint
  decode_mode?: "sequential" | "batch";
  trim_tail?: boolean;              // default true
  tail_window_size?: number;        // 1–200, default 20
  tail_std_threshold?: number;      // 0.001–1, default 0.05
  tail_mean_threshold?: number;     // 0.001–1, default 0.1
};

type SynthesisRequest = {
  text: string;                     // Japanese; may contain emoji annotations; ≤ 2000 chars
  caption?: string | null;          // style prompt; ≤ 1000 chars
  reference?: ReferenceInput;       // default { kind: "none" }
  lora_adapter?: string | null;     // absolute adapter directory (with adapter_config.json)
  params?: SamplingParams;
  apply_dictionary?: boolean;       // default true: rewrite the text with the user dictionary first
};

// Milliseconds per stage: upstream stage names (prepare_lora, tokenize_text,
// prepare_reference, predict_duration, sample_rf, unpatchify_latent, decode_latent,
// silentcipher_watermark, total_to_decode) plus encode_reference, synthesize, write_audio.
type Timings = Record<string, number>;
```

---

## Internal API

### System & lifecycle
| Method | Path | Notes |
| --- | --- | --- |
| GET | `/health` | `{status: "ok", engine: EngineStatus}`; answers while the model loads |
| GET | `/system` | `SystemInfo` below (S1) |
| POST | `/system/cache/clear` | free accelerator cache |

CORS: only the app's own WebView origins may read the internal API (`tauri://localhost`, `http(s)://tauri.localhost`, plus the dev server origin in debug builds), passed by Rust as `IRODORI_ALLOWED_ORIGINS`.

```ts
type EngineStatus = {
  state: "idle" | "loading" | "ready" | "error"; // the model loads at startup (D4)
  model_id: string | null;
  error_code: string | null;           // e.g. "model_files_missing" when state = "error"
  runtime: RuntimeInfo | null;         // options of the resident model (a change reloads it, D4)
};

type RuntimeInfo = {
  device: "cuda" | "mps" | "cpu"; model_precision: "fp32" | "bf16";
  codec_device: "cuda" | "mps" | "cpu"; codec_precision: "fp32" | "bf16";
  compile_model: boolean; compile_dynamic: boolean;
};

type SystemInfo = {
  app_version: string;
  python_version: string;
  platform: "windows" | "macos" | "linux" | "other";
  device: {
    kind: "cuda" | "mps" | "cpu";      // configured device (setup marker)
    precision: "fp32" | "bf16";
    available: boolean;                // usable by torch right now
    name: string | null;               // GPU name, or CPU/processor string
    compute_capability: string | null; // CUDA only, e.g. "12.0"
    memory_total_mb: number | null;    // VRAM (CUDA) or system/unified memory, MiB
    memory_used_mb: number | null;
  };
  torch: { version: string; cuda_version: string | null; cuda_available: boolean; mps_available: boolean } | null;
  upstream_commit: string | null;      // sidecar/upstream.json
  active_model: string | null;         // set once the model is ready
  queue_length: number;                // running + queued jobs
  watermark_available: boolean | null; // SilentCipher loaded; null until the model is ready
  ffmpeg_available: boolean;           // other audio formats can be read (clips) and saved
  issues: ("torch_unavailable" | "cuda_unavailable" | "mps_unavailable" | "watermark_unavailable" | "model_load_failed")[];
};
```

The first `/system` call imports torch (seconds); later calls are fast.

### Models
| Method | Path | Notes |
| --- | --- | --- |
| GET | `/models` | `ModelInfo[]`: registry entries with install state (S2) |
| POST | `/models/{id}/download` | job; progress in bytes |
| DELETE | `/models/{id}` | remove files (not the active one) |
| POST | `/models/load` | `{model_id, runtime: {device, model_precision, codec_precision, compile_model, compile_dynamic}}` → job |
| POST | `/models/unload` | |
| GET | `/models/active/capabilities` | `ModelCapabilities`: the parameter schema for the UI (S2) |
| GET | `/emoji` | `EmojiItem[]`: upstream's emoji palette (S2) |

```ts
type Capabilities = {
  caption: boolean; speaker_reference: boolean; speaker_embedding: boolean; lora: boolean;
  duration_predictor: boolean; max_ref_seconds: number; max_output_seconds: number;
  sampling: "rf" | "meanflow"; ignores: string[];
};

type ModelInfo = {
  id: string; display_name: string; tier: string; size_bytes_approx: number;
  installed: boolean;                  // every required file is on disk
  active: boolean;
  capabilities: Capabilities;
};

type ParamSchema = {
  name: keyof SamplingParams;
  type: "int" | "float" | "bool" | "enum";
  default: number | boolean | string | null; // the model's default (Space values, D26)
  nullable: boolean;                   // null = auto/off is allowed
  min: number | null; max: number | null; step: number | null;
  choices: string[] | null;
  group: "sampling" | "duration" | "cfg" | "speaker" | "reference" | "advanced";
  tier: "simple" | "advanced";
  // Visible when every key's current value is listed; key "reference" = the reference kind.
  visible_when: Record<string, (string | boolean)[]> | null;
};

type ModelCapabilities = {
  model_id: string; display_name: string; capabilities: Capabilities;
  params: ParamSchema[];               // only the parameters this model supports
  limits: { max_candidates: number; max_text_chars: number; max_caption_chars: number;
            max_clips: number; max_clip_seconds: number; max_upload_bytes: number };
};

type EmojiItem = {
  symbol: string;                      // e.g. "👂"
  key: string;                         // stable i18n id from the code points, e.g. "u1f442"
  label_ja: string;                    // upstream's Japanese label and description: source
  description_ja: string;              // data the UI localizes via `key` (D17)
};
```

### Generation & jobs
| Method | Path | Notes |
| --- | --- | --- |
| POST | `/tts/generate` | body `SynthesisRequest` → `202 JobAccepted`; validated before queuing |
| GET | `/jobs/{id}` | `JobInfo` snapshot |
| GET | `/jobs/{id}/events` | SSE (below) |
| POST | `/jobs/{id}/cancel` | `{job_id, state}`: `cancelled` (was queued), `cancelling` (running; cooperative, D27), or the final state if it already finished |
| GET | `/queue` | `QueueSnapshot`: the running job and the queued ones in order (UI + external) |
| GET | `/audio/{audio_id}` | `audio/wav`, 48 kHz mono 16-bit |
| POST | `/audio/{audio_id}/save` | `{path, format?: "wav"\|"mp3"\|"m4a"\|"flac"\|"opus", post?: PostOptions}` (absolute path from the native save dialog; without `format`, the extension decides, else WAV; the format's extension is applied; an existing file is replaced) → `{path, bytes, format}`. Formats other than WAV and any post-processing go through ffmpeg (MP3 VBR ≈ 190 kbps, M4A AAC 192 kbps, FLAC, Opus 128 kbps): `400 ffmpeg_unavailable` without it; `400 save_path_invalid` / `save_failed` |

```ts
type JobAccepted = { job_id: string; queue_position: number }; // jobs ahead of this one
type AudioOutput = { index: number; audio_id: string; duration_s: number };
type TtsResult = { history_id: string; used_seed: number; timings: Timings; outputs: AudioOutput[]; watermarked: boolean };
type EncodeResult = { voice_id: string; encoded: number }; // clips encoded by an "encode" job
type NarrationResult = { narration_id: string; rendered: number }; // chunks rendered by a "narration" job
type ScriptResult = { script_id: string; rendered: number };        // lines rendered by a "script" job
type JobInfo = {
  job_id: string; kind: "tts" | "encode" | "narration" | "script";
  state: "queued" | "running" | "completed" | "failed" | "cancelled";
  queue_position: number | null;       // while queued
  created_at: string; started_at: string | null; finished_at: string | null;
  error: { code: string; message: string } | null;
  result: TtsResult | EncodeResult | NarrationResult | ScriptResult | null;
};
type QueueItem = { job_id: string; kind: "tts" | "encode" | "narration" | "script"; source: "ui" | "api"; state: "queued" | "running"; created_at: string };
type QueueSnapshot = { running: QueueItem | null; queued: QueueItem[] };
```

SSE (`text/event-stream`): each event has `event: <type>`, `id: <sequence number>` and one JSON `data:` line. A new subscriber first receives the job's past events, so subscribing late loses nothing; the stream ends after the terminal event, and a reconnect with `Last-Event-ID` resumes after that event.

| Event | Data |
| --- | --- |
| `queued` | `{position}`: on submit and whenever the position changes |
| `started` | `{}` |
| `log` | `{line}`: upstream and sidecar log lines (developer text) |
| `progress` | `{done, total, unit}`: `unit` is `"step"` (sampling steps) for single generations and for the chunk being rendered, `"clip"` for encode jobs (after each clip), `"chunk"` for narration jobs (after each chunk), `"line"` for script jobs (after each line) |
| `candidate` | `AudioOutput`, one per candidate, before `completed` |
| `chunk` | narration jobs: `{index, takes: Take[], adopted_audio_id}` — a chunk's new takes (the first one adopted) |
| `line` | script jobs: `{line_id, index, takes: Take[], adopted_audio_id}` — a line's new takes (the first one adopted) |
| `completed` | `TtsResult`, `EncodeResult` for an encode job, `NarrationResult` for a narration job, `ScriptResult` for a script job (terminal) |
| `failed` | `{code, message}` (terminal) |
| `cancelled` | `{}` (terminal) |

A single generation streams `queued → started → log / progress … → candidate × N → completed`; an encode job `queued → started → log / progress (unit "clip") … → completed`; a narration job `queued → started → (progress "step" … → chunk → progress "chunk") × chunks → completed`; a script job `queued → started → (progress "step" … → line → progress "line") × lines → completed` (a line edited or deleted meanwhile sends no `line` event). Failures detected only at run time include `watermark_unavailable` (the watermark is on but SilentCipher did not load, D12), `model_load_failed` / `model_files_missing`, `out_of_memory`, `invalid_params` (rejected upstream) and `synthesis_failed`.

### Clips
Reference audio: ad-hoc clips for `ReferenceInput.kind = "clips"`, and the clips a library voice owns (upload first, then list them in `POST /voices` / `PATCH /voices/{id}`). A clip is stored once as float WAV with its encoded latents cached per model/codec/normalization. Edits never change a clip: trim and split create new clips that take its place (inside its voice too) and delete it. Clips no voice owns are deleted a day after upload, at sidecar start (D13).

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/clips` | multipart `file` + optional form field `origin: "upload" \| "recording"` (default `upload`; `recording` = recorded in the app) → `201 ClipInfo`. WAV/FLAC/OGG/Opus/MP3; other formats need ffmpeg (`415 clip_format_unsupported`). At most 100 MB (`413 clip_too_large`) and 10 min (`413 clip_too_long`); at least 0.1 s (`422 clip_too_short`) |
| GET | `/clips/{id}` | `ClipInfo` |
| GET | `/clips/{id}/audio` | `audio/wav` 16-bit, for playback and waveforms |
| POST | `/clips/{id}/trim` | `{start_s, end_s}` → the new `ClipInfo`; `400 clip_range_invalid` outside the clip, `422 clip_too_short` under 0.1 s |
| POST | `/clips/{id}/split` | `{at_s: number[]}` (1–31 cut points) → the pieces `ClipInfo[]` in order |
| DELETE | `/clips/{id}` | `204`; `409 clip_in_use` (`detail.voice_id`) for a voice's clip — change the voice instead |

```ts
type ClipOrigin = "upload" | "recording" | "generated"; // upload/recording may be a real person (D13)
type ClipInfo = {
  clip_id: string; filename: string; duration_s: number; sample_rate: number; channels: number; created_at: string;
  origin: ClipOrigin;
  voice_id: string | null;             // the library voice that owns the clip
};
```

### History & preferences
| Method | Path | Notes |
| --- | --- | --- |
| GET | `/history` | `?limit=1–200 (50)&offset=0&q=&voice=&since=&before=` → `{items: HistorySummary[], total}`, newest first. `q` matches text or caption; `voice` is a library voice id or `none` (entries without one); `since` (inclusive) and `before` (exclusive) are ISO 8601 UTC |
| GET | `/history/usage` | `{entries, bytes}` the history holds |
| GET / DELETE | `/history/{id}` | `HistoryEntry`: the request as submitted, every resolved parameter, seed and timings; DELETE also removes its audio |
| PATCH | `/history/{id}` | `{adopted_audio_id: string \| null}` adopts one of its candidates (or clears it) → `HistoryEntry`; `404 audio_not_found` for another entry's audio |
| POST | `/history/{id}/regenerate` | `RegenerateRequest` → `202 JobAccepted`: the request as submitted again, a new history entry; the entry's used seed unless `seed` is given (`null`: a new random one); `404 history_not_found`, and the request's own errors (e.g. `voice_not_found`, `clip_not_found` when its reference is gone) |
| POST | `/history/export` | `HistoryExportRequest` → `{files: ExportedFile[]}`: each entry's adopted candidate (else its first) into an existing folder, named by the template (files of the same name are replaced), with post-processing; `422 naming_template_invalid` |
| GET / PATCH | `/preferences` | `Preferences`; PATCH takes any subset of the fields; lowering a history limit prunes at once |

```ts
type HistorySummary = {
  id: string; created_at: string; model_id: string; text: string; caption: string | null;
  reference_kind: "none" | "voice" | "clips" | "embedding";
  used_seed: number; watermarked: boolean; outputs: AudioOutput[];
  adopted_audio_id: string | null;     // the candidate the user adopted (requirements §6.3)
  voice_id: string | null;             // the library voice of a {kind: "voice"} request
  source: "ui" | "api";                // who asked: the app or the external API (D21)
};
type HistoryEntry = HistorySummary & {
  request: SynthesisRequest;           // as submitted (unset fields absent)
  params: Required<SamplingParams>;    // every value actually used, incl. the seed
  timings: Timings; messages: string[]; device: string; precision: string;
};

// Settings the sidecar applies per request, kept in its database (decisions.md, S2).
type Preferences = {
  watermark_enabled: boolean;          // default true (D12; see watermark_policy)
  history_max_entries: number;         // default 500 (D23); the oldest entries are pruned
  history_max_bytes: number;           // default 5 GB
  output: OutputOptions;               // the export settings every screen shares (D20)
};
type RegenerateRequest = { seed?: number | null; num_candidates?: number | null };
type HistoryExportRequest = {
  history_ids: string[];               // 1–1000
  folder: string;                      // absolute, from the native folder dialog
  format?: AudioFormat; post?: PostOptions | null;
  naming_template?: string;            // default "{date}_{text_head}": {date} 20260925-143000 (local time), {n} 1, {index} 001, {text_head}, {seed}, {id}
};
type HistoryUsage = { entries: number; bytes: number };
```

### Text
The user dictionary rewrites text before it reaches the model (`apply_dictionary`, default true, in `SynthesisRequest` and narration settings): at each position the longest surface wins, matches never overlap, and a surface also matches its full-width / half-width form. History keeps the text as submitted and notes the replacement count in `messages`. The reading preview estimates katakana with pyopenjtalk-plus (D19) — a hint, not what the model will say.

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/dictionary` | `DictionaryEntry[]` in order |
| PUT | `/dictionary` | `DictionaryEntryInput[]` (the whole list, ≤ 5000) → `DictionaryEntry[]`; `422 dictionary_invalid` with `detail {reason: "surface" \| "reading" \| "duplicate" \| "too_many", index, other?}` (two enabled entries may not share a surface) |
| POST | `/text/reading` | `{text (≤ 20000), apply_dictionary?: true}` → `ReadingResult` |

```ts
type DictionaryEntryInput = { surface: string; reading: string; enabled: boolean; note: string | null }; // 1–64 / 1–128 / ≤ 200 chars
type DictionaryEntry = DictionaryEntryInput & { id: string };
type ReadingToken = {
  surface: string; reading: string;    // estimated katakana; a dictionary token's reading is its replacement
  moras: number;
  source: "analyzer" | "dictionary" | "symbol" | "text";   // "text": no analyzer installed
};
type ReadingResult = { tokens: ReadingToken[]; moras: number; estimated_seconds: number; analyzer: boolean };
```

### Voices
The voice library (requirements §6.5). A voice is a speaker identity — ordered clips, a speaker embedding, or only a caption — plus defaults the client applies to a generation (the sidecar uses only the identity for `{kind: "voice"}`). Voices from real people's audio need recorded consent (D13): `source` `imported` / `recorded`, or any clip with origin `upload` / `recording`. Saving queues an `encode` job on the synthesis queue when clips lack latents for the active model ("encode on save"), so generations skip the encoder.

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/voices` | `Voice[]`, newest first |
| POST | `/voices` | `VoiceCreate` → `201 VoiceSaved`. `422 consent_required` without consent where needed; `422 voice_invalid` (empty name, no clips for imported/recorded, a designed voice with neither audio nor caption, an embedding voice without exactly one file); `409 clip_in_use` for another voice's clip; `422 embedding_invalid` / `404 embedding_not_found`; `404 lora_not_found`; `422 invalid_params` |
| GET | `/voices/{id}` | `Voice` |
| PATCH | `/voices/{id}` | `VoicePatch` (only the fields sent change; `null` clears) → `VoiceSaved`. `clip_ids` is the new ordered list: clips left out are deleted; added real-voice clips need `consent` when the voice has none |
| DELETE | `/voices/{id}` | `204`; deletes its clips and files too |
| POST | `/voices/{id}/encode` | `JobAccepted`, or `null` when already encoded for the active model (e.g. after trim/split) |
| POST | `/voices/{id}/export` | `{path}` (absolute, from the native save dialog; `.irovoice` appended) → `{path, bytes}`; `409 consent_required` for a voice lacking consent |
| GET | `/voices/{id}/export` | the `.irovoice` bytes (`application/zip`, attachment) |
| POST | `/voices/import` | multipart `file` (`.irovoice`, ≤ 400 MB) → `201 VoiceSaved`; keeps the package's consent record and model id; `422 package_invalid`, `422 consent_required` for a real voice without consent |

```ts
type VoiceSource = "designed" | "imported" | "recorded" | "embedding";
type ConsentInput = { statement: string; locale: string }; // the statement exactly as shown (10–2000 chars)
type Consent = ConsentInput & { confirmed_at: string; version: number };
type Voice = {
  id: string; name: string; source: VoiceSource; created_at: string; updated_at: string;
  model_id: string;                    // the model it was created with
  caption_default: string | null; params_default: SamplingParams; seed_default: number | null;
  lora_path: string | null; test_text: string | null;
  design_caption: string | null;       // designed voices: the caption they were designed from
  clips: ClipInfo[]; total_seconds: number;
  embedding: { filename: string; tokens: number; dim: number } | null;
  consent: Consent | null;
  consent_required: boolean;           // some clip (or the source) is a real person's voice
  encoded: boolean;                    // every clip has latents for the active model
};
type VoiceCreate = {
  name: string; source: VoiceSource;
  clip_ids?: string[];                 // ≤ 32, from POST /clips, unowned or already this voice's
  from_audio_id?: string | null;       // designed: keep this generated candidate as a clip (origin "generated")
  embedding_path?: string | null;      // embedding: absolute path of a Speaker Inversion file, copied in
  consent?: ConsentInput | null;
  caption_default?: string | null; params_default?: SamplingParams; // seed goes in seed_default
  seed_default?: number | null; lora_path?: string | null; test_text?: string | null;
  design_caption?: string | null;
};
type VoicePatch = Partial<Omit<VoiceCreate, "source" | "from_audio_id" | "design_caption">>;
type VoiceSaved = { voice: Voice; encode_job_id: string | null };
```

Speaker embeddings must be a safetensors file whose `speaker_embedding` tensor is float `(tokens, dim)` with the model's speaker dim (768 for v4.1) — the shape upstream's inference path loads. The library stores it as `voices/<id>/voice.speaker.safetensors` (upstream requires the suffix); ad-hoc `{kind: "embedding"}` paths are copied to a suffixed temp file when needed.

`.irovoice` (D22) is a zip: `voice.json` (`format: "irovoice"`, `version: 1`, name, source, model id, defaults, consent, clip entries `{file, filename, origin}`), `clips/NN.flac` (24-bit), and `voice.speaker.safetensors` for embedding voices. Latents are not included; they are re-encoded on import.

### Narration
Long-form manuscripts (requirements §6.6, D18) kept in the sidecar: split into chunks, rendered chunk by chunk as one queue job, joined with pauses into one file with subtitles. Takes are audio rows owned by the narration (never pruned with the history) and play or save through `/audio/{id}`.

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/narrations` | `NarrationSummary[]`, most recently changed first |
| POST | `/narrations` | `NarrationCreate` → `201 Narration`: the manuscript is split now. `422 subtitle_invalid` (format `srt` without cues), `422 text_empty`, `422 text_too_long` (> 2000 chunks), `422 invalid_request` (`min_chars` > `max_chars`) |
| GET / DELETE | `/narrations/{id}` | `Narration` / `204` (with its audio) |
| PATCH | `/narrations/{id}` | `{title?, settings?}` → `Narration`; settings are validated like a request (consent, LoRA, parameters) and clear the assembled file |
| POST | `/narrations/{id}/split` | `NarrationSplit` → `Narration`: split again, every take is discarded; `409 narration_busy` while rendering |
| PATCH | `/narrations/{id}/chunks/{index}` | `{text}` (the chunk's takes are discarded) or `{adopted_audio_id}` (one of its takes) → `Narration`; `404 chunk_not_found` / `audio_not_found` |
| POST | `/narrations/{id}/render` | `RenderRequest` → `JobAccepted` (kind `narration`), or `null` when nothing needs rendering; `409 narration_busy` if one is queued or running. Default: every chunk without an adopted take, in order — resuming after a cancel; `redo` adds and adopts a new take |
| POST | `/narrations/{id}/assemble` | → `AssembledNarration`; `409 narration_incomplete` (`detail.missing`: indices without a take) |
| POST | `/narrations/{id}/export` | `NarrationExportRequest` → `{files: ExportedFile[]}`: the joined file (assembled first if needed; formats as `/audio/{id}/save`), `.srt` / `.vtt` beside it, and optionally `<name>_NNN.<ext>` per chunk |

```ts
type NarrationFormat = "text" | "markdown" | "srt";    // "srt" also reads WebVTT
type PauseKind = "clause" | "sentence" | "paragraph" | "cue";
type SplitRules = { min_chars: number; max_chars: number }; // 1–400 / 20–400, default 80 / 150
type NarrationSettings = {
  reference: ReferenceInput; caption: string | null; lora_adapter: string | null;
  params: SamplingParams;              // as in a request; the client loads a library voice's defaults
  pauses: { sentence_ms: number; paragraph_ms: number };  // default 400 / 900; a clause gets half the sentence pause
  voice_lock: boolean;                 // default true: without speaker audio, chunk 1's take is the others' reference
  apply_dictionary: boolean;           // default true
};
// A narration chunk's or a script line's generated audio; `truncated`: within 50 ms of the output limit.
type Take = { audio_id: string; duration_s: number; seed: number; truncated: boolean; created_at: string };
type NarrationChunk = {
  index: number; text: string; pause_after: PauseKind; estimated_seconds: number;
  cue: { start_ms: number; end_ms: number } | null;   // SRT input: generated at the cue's length
  takes: Take[]; adopted_audio_id: string | null;
};
type SubtitleCue = { index: number; start_ms: number; end_ms: number; text: string };
type Narration = {
  id: string; title: string; created_at: string; updated_at: string;
  format: NarrationFormat; source: string; rules: SplitRules; settings: NarrationSettings;
  chunks: NarrationChunk[];
  warnings: { code: "cue_too_long" | "cue_overlap" | "chunk_too_long"; index: number }[];
  assembled: { audio_id: string; duration_s: number; cues: SubtitleCue[] } | null;
  analyzer: boolean;                   // estimates from mora counts (else from characters)
  render_job_id: string | null;        // a render queued or running, to follow
};
type NarrationSummary = { id: string; title: string; created_at: string; updated_at: string; format: NarrationFormat; chunks: number; rendered: number };
type NarrationCreate = { title?: string | null; source: string; format?: NarrationFormat; rules?: SplitRules; settings?: NarrationSettings };
type NarrationSplit = { source: string; format?: NarrationFormat; rules?: SplitRules };
type RenderRequest = { indices?: number[] | null; redo?: boolean; num_candidates?: number | null };
type NarrationExportRequest = { path: string; format?: AudioFormat; subtitles?: ("srt" | "vtt")[]; per_chunk?: boolean; post?: PostOptions | null };
```

Assembly trims each adopted take's silence (keeping 30 ms before and 60 ms after the sound, threshold −50 dBFS) and places it after the previous one plus the pause (text) or at its cue start (SRT; after the previous take if that one runs long). Subtitle cues are the takes' exact positions; SRT input keeps its cue end when the take starts on time.

### Script
Multi-speaker dialogue (requirements §6.7) kept in the sidecar: lines from "話者：セリフ" text or a CSV / TSV table, a speaker → voice map, rendered line by line as one queue job with takes per line, exported as one file per line plus the merged drama with subtitles, and written back as a table. Takes are audio rows owned by the script (never pruned with the history) and play or save through `/audio/{id}`. Lines have stable ids, so their takes survive inserting, deleting and reordering lines.

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/scripts` | `ScriptSummary[]`, most recently changed first |
| POST | `/scripts` | `ScriptCreate` → `201 Script`: the source is parsed now. `422 script_invalid` (`detail.reason`: `empty`; `header` — a table without a text column; `value` — with `row` and `column` for a bad number in a table, or `line` for a line out of range), `422 text_too_long` (> 5000 lines), `422 naming_template_invalid` (`detail.token`); settings are validated like a request |
| GET / DELETE | `/scripts/{id}` | `Script` / `204` (with its audio); `409 script_busy` while rendering |
| PATCH | `/scripts/{id}` | `ScriptPatch` → `Script`: title, settings (validated like a request) or the speaker map (names unique, `404 voice_not_found`; a speaker the lines use keeps an entry even when left out); clears the assembled file |
| POST | `/scripts/{id}/import` | `ScriptImport` → `Script`: `append` adds lines at the end; `replace` discards every line and take (`409 script_busy` while rendering) |
| POST | `/scripts/{id}/lines` | `LineInsert` → `Script` |
| PATCH / DELETE | `/scripts/{id}/lines/{line_id}` | `LinePatch` → `Script`: new text or another speaker discards the line's takes; `adopted_audio_id` must be one of its takes (`404 audio_not_found`) / → `Script`; `404 line_not_found` |
| POST | `/scripts/{id}/lines/{line_id}/move` | `{position}` → `Script` |
| POST | `/scripts/{id}/render` | `ScriptRenderRequest` → `JobAccepted` (kind `script`), or `null` when nothing needs rendering; `409 script_busy` if one is queued or running. Default: every line without an adopted take, in order — resuming after a cancel; `redo` adds and adopts a new take |
| POST | `/scripts/{id}/assemble` | → `AssembledScript`; `409 script_incomplete` (`detail.missing`: ids of lines without a take) |
| POST | `/scripts/{id}/export` | `ScriptExportRequest` → `{files: ExportedFile[]}` into an existing folder (files of the same name are replaced): one file per line named by the template, and the merged drama `<title>.<ext>` (assembled first if needed) with `.srt` / `.vtt` beside it; formats as `/audio/{id}/save`; `409 script_incomplete` |
| POST | `/scripts/{id}/file-names` | `{naming_template}` → `{names: string[]}`: the per-line names (without extension) a template gives, to preview it before saving; `422 naming_template_invalid` |
| POST | `/scripts/{id}/table` | `ScriptTableRequest` → `ExportedFile`: the lines as CSV / TSV (UTF-8 with a BOM, header row), which `POST /scripts` reads back unchanged |

```ts
type ScriptFormat = "text" | "csv" | "tsv";
type ScriptSpeaker = { name: string; voice_id: string | null; caption: string | null }; // name ≤ 32 chars
type ScriptSettings = {
  params: SamplingParams;              // every line, over each voice's defaults
  pause_ms: number;                    // 0–10000, default 500: after a line unless it sets its own
  naming_template: string;             // default "{index}_{speaker}_{text_head}"
  subtitle_speakers: boolean;          // default true: "話者：セリフ" (SRT) / "<v 話者>セリフ" (WebVTT)
  apply_dictionary: boolean;           // default true
};
type ScriptLineInput = {
  speaker: string; text: string;       // text 1–1000 chars
  caption?: string | null; num_candidates?: number | null; seed?: number | null;
  pause_ms?: number | null;
  file_name?: string | null;           // instead of the naming template
};
type ScriptLine = Required<ScriptLineInput> & { id: string; index: number; takes: Take[]; adopted_audio_id: string | null };
type ScriptCue = SubtitleCue & { line_id: string; speaker: string };
type AssembledScript = { audio_id: string; duration_s: number; cues: ScriptCue[] };
type Script = {
  id: string; title: string; created_at: string; updated_at: string;
  speakers: ScriptSpeaker[]; settings: ScriptSettings; lines: ScriptLine[];
  assembled: AssembledScript | null;
  render_job_id: string | null;        // a render queued or running, to follow
};
type ScriptSummary = { id: string; title: string; created_at: string; updated_at: string; lines: number; rendered: number; speakers: number };
type ScriptCreate = { title?: string | null; source: string; format?: ScriptFormat; settings?: ScriptSettings };
type ScriptImport = { source: string; format?: ScriptFormat; mode?: "replace" | "append" };
type ScriptPatch = { title?: string; settings?: ScriptSettings; speakers?: ScriptSpeaker[] };
type LinePatch = Partial<ScriptLineInput> & { adopted_audio_id?: string | null }; // only the fields sent change; null clears
type LineInsert = { line: ScriptLineInput; position?: number | null };             // omitted: at the end
type ScriptRenderRequest = { line_ids?: string[] | null; redo?: boolean; num_candidates?: number | null };
type ScriptExportRequest = { folder: string; format?: AudioFormat; per_line?: boolean; merged?: boolean; subtitles?: ("srt" | "vtt")[]; post?: PostOptions | null };
type ScriptTableRequest = { path: string; format?: "csv" | "tsv" };  // the format's extension is applied
```

Text: one line per text line, as "話者：セリフ", "話者: セリフ" or "話者「セリフ」"; a line without a speaker continues the previous speaker, lines wholly in parentheses (stage directions) are skipped, and 「」 around a whole line are removed. Tables have a header row — `index, speaker, text, caption, candidates, seed, pause_ms, file` or Japanese names such as 話者 / セリフ / キャプション / 候補数 / シード / 行後の間 / ファイル名 (other columns are ignored); a table without a recognized header is read as speaker, text.

Each line's request: the speaker's voice supplies the reference, LoRA and defaults (caption, parameters, seed); the script's parameters override them, and the line's own candidates and seed override those. The caption is the line's, else the speaker's, else the voice default; a speaker without a voice renders without a reference. Assembly trims each adopted take's silence as for narration and joins the takes with each line's pause (`pause_ms`, else the script's); subtitle cues are the takes' exact positions. Per-line file names are the line's own `file_name` or the template (`{index}` zero-padded to at least 3 digits, `{n}`, `{speaker}`, `{text_head}` = the first 12 characters, `{title}`, `{id}`), with characters unsafe on Windows or macOS replaced by `_`, at most 120 characters, and made unique within the script (`_2`, `_3`, …).

### Output post-processing (D20)
Every export takes the same optional `post` next to its format: `/audio/{id}/save`, `/narrations/{id}/export`, `/scripts/{id}/export`, `/history/export`. The screens share one set of export settings, kept in `Preferences.output`.

```ts
type AudioFormat = "wav" | "mp3" | "m4a" | "flac" | "opus";  // M4A is AAC
type PostOptions = {                   // the defaults change nothing
  sample_rate?: 48000 | 44100;         // default 48000; Opus is always 48 kHz
  loudness?: -14 | -16 | -23 | null;   // integrated LUFS target (EBU R128), default off
  tempo?: number;                      // 0.5–2.0, default 1: a time stretch that keeps the pitch
  gain_db?: number;                    // -20–20, default 0; not used when loudness is set
};
type OutputOptions = PostOptions & { format: AudioFormat };
```

Loudness is two-pass `loudnorm` (measured first, then normalized linearly when the true-peak ceiling of -1 dBTP allows, else ffmpeg's dynamic mode). With a changed tempo, subtitle cues are moved with the audio (times ÷ tempo). A WAV without post-processing is copied as generated; everything else needs ffmpeg (`400 ffmpeg_unavailable`).

### Presets
| Method | Path | Notes |
| --- | --- | --- |
| GET | `/presets` | `Preset[]` by name |
| POST | `/presets` | `PresetInput` → `201 Preset`; parameters checked against the active model (`422 invalid_params`) |
| PATCH / DELETE | `/presets/{id}` | `{name?, params?}` → `Preset` / `204`; `404 preset_not_found` |

```ts
type PresetInput = { name: string; params: SamplingParams };  // name 1–60 chars; only the values given
type Preset = PresetInput & { id: string; created_at: string; updated_at: string };
```

A preset keeps the values that were given (those that differ from the defaults); the client loading one sets exactly those and leaves the rest at their defaults.

### Projects (D23)
| Method | Path | Notes |
| --- | --- | --- |
| POST | `/projects/save` | `{kind: "narration" \| "script", id, path}` → `ExportedFile`: one `.iroproj` file (the extension is applied); `404 narration_not_found` / `script_not_found`, `400 save_path_invalid` |
| POST | `/projects/open` | `{path}` → `201 ProjectOpened`: a new narration or script with its adopted takes; `422 project_invalid` (`detail.reason`: `zip`, `format`, `version`, `content`, `audio`, `size`) |

```ts
type ProjectOpened = {
  kind: "narration" | "script"; id: string;
  missing_voices: string[];            // library voices (by name) this library lacks: dropped
  missing_lora: string[];              // LoRA adapters not found: dropped
};
```

`.iroproj` is a zip: `project.json` (`format: "iroproj"`, `version: 1`, `kind`, `app_version`, `model_id`, `saved_at`, `voices: {id: name}`, and `narration` — title, format, source, rules, settings, warnings, chunks `{text, pause_after, estimated_seconds, cue, take}` — or `script` — title, speakers, settings, lines `{speaker, text, caption, num_candidates, seed, pause_ms, file_name, take}`) and each adopted take as 16-bit FLAC `audio/NNNN.flac` (`take: {file, seed, truncated}`), so the takes come back bit for bit. Only adopted takes are saved; the assembled file is made again. Projects are saved in `<data-root>/projects/` by default.

### External API control (D21)

The optional second listener, configured and watched from the API Server screen. Its configuration is kept in the preferences table (key `api_server`); when enabled, the listener starts with the sidecar and stops with it. The port is bound before uvicorn starts, so a port in use becomes a status instead of a sidecar exit.

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api-server/config` | `ApiServerConfig` |
| PUT | `/api-server/config` | `ApiServerConfig` → `ApiServerStatus`: saved and applied at once (the listener starts, restarts or stops); `422 api_key_required` for a LAN bind without a key |
| GET | `/api-server/status` | `ApiServerStatus` (the screen polls it every 2 s) |
| GET | `/api-server/styles` | `ApiStyle[]`: the VOICEVOX speakers and styles on offer, in order |

```ts
type ApiServerConfig = {
  enabled: boolean;                    // default false
  bind: "local" | "lan";               // 127.0.0.1, or every IPv4 interface (0.0.0.0)
  port: number;                        // 1024–65535, default 50221
  api_key: string | null;              // 8–200 visible ASCII characters, no spaces; required for "lan"
};
type ApiServerStatus = {
  running: boolean;
  error: string | null;                // why it is not running: api_port_in_use | api_key_required | internal_error
  urls: string[];                      // http://127.0.0.1:<port>, plus this computer's LAN addresses for "lan"
  requests: ApiRequestLog[];           // the last 200, newest first; memory only
};
type ApiRequestLog = {
  time: string; client: string; method: string; path: string; status: number;
  duration_ms: number; family: "openai" | "voicevox" | "other";
};
type ApiStyle = {
  style_id: number; speaker_uuid: string; voice_id: string; voice_name: string;
  style: string;                       // "normal" or a style preset id ("calm", "bright", …)
  name: string;                        // the VOICEVOX style name (Japanese protocol data)
};
```

---

## External API

Served on `<bind>:<port>` by the second listener, which shares the sidecar's services: one resident model and one synthesis queue with the UI (D4, D24). Its jobs have `source: "api"` and are kept in the history like the UI's (`HistorySummary.source`); the user dictionary applies as in the app. A client that disconnects cancels its queued or running job. No OpenAPI docs are served on this listener.

- **API key:** when one is set (always for a LAN bind), every request needs `Authorization: Bearer <key>` or `X-API-Key: <key>`, compared in constant time; otherwise `401` — `{"error": {"message": "Invalid API key.", "type": "invalid_request_error", "param": null, "code": "invalid_api_key"}}` under `/v1`, `{"detail": "Invalid API key."}` elsewhere. CORS preflights pass without it.
- **CORS:** pages served from this computer (`http(s)://localhost`, `127.0.0.1` or `[::1]`, any port) may call the API, like the VOICEVOX engine's default policy.
- **Request log:** every request, refused ones included, is recorded for the API Server screen.
- **Voices:** library voices from a real person's audio are offered only with recorded consent (D13).

## External API — OpenAI compatible

Shaped like upstream `Aratako/Irodori-TTS-Server`, so its clients and the OpenAI SDKs work unchanged (`OpenAI(base_url="http://127.0.0.1:50221/v1", api_key=...)`).

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/v1/models` | `{object: "list", data: [{id: "irodori-tts", object: "model", created: 0, owned_by: "irodori-tts"}]}` |
| GET | `/v1/audio/voices` | `{object: "list", data: [{id, object: "voice", name, source, caption, no_ref}]}`: the library voices |
| GET | `/v1/audio/voices/{id}` | one voice by id or name; `404 voice_not_found` |
| POST | `/v1/audio/speech` | `SpeechRequest` → the audio, or an SSE stream with `stream_format: "sse"` |

```ts
type SpeechRequest = {
  model: string;                       // "irodori-tts" (tts-1, tts-1-hd and gpt-4o-mini-tts are accepted too)
  input: string;                       // 1–20000 characters
  voice?: string | { id: string };     // a library voice id, or a name (the first in library order); "none" (or absent) = no reference
  response_format?: "wav" | "mp3" | "flac" | "opus" | "aac" | "pcm";  // default wav; pcm = raw s16le mono, 48 kHz
  speed?: number;                      // 0.25–4.0, default 1
  stream_format?: "sse";
  irodori?: {                          // the extension; its keys are also read at the top level
    ...SamplingParams;                 // num_steps, seed, cfg_scale_*, seconds, duration_scale, …
    caption?: string;
    lora_adapter?: string;             // an adapter folder on this computer
    chunking_enabled?: boolean;        // default true (alias: chunking)
    chunk_min_chars?: number;          // default 80
    first_sentence_chunk_min_chars?: number;
    ref_wav?: string; ref_wavs?: string[];  // audio files on this computer, as ad-hoc reference clips
    ref_embed?: string;                // a .speaker.safetensors on this computer
    no_ref?: boolean;                  // no reference, even with a voice
  };
};
```

- **Voice defaults:** a library voice brings its caption, parameters, seed and LoRA; the request's values take precedence. `ref_wav(s)`, `ref_embed` and `no_ref` replace the voice's reference; `ref_latent(s)` (upstream's latent files) are refused with `reference_unsupported`.
- **File paths** (`ref_wav`, `ref_wavs`, `ref_embed`, `lora_adapter`) are accepted only from this computer (a loopback client), so a LAN client cannot make the app read arbitrary files; otherwise `403 path_not_allowed`.
- **Speed:** `duration_scale = base / speed` within the model's range (base: the request's or voice's `duration_scale`, else 1); the rest is an `atempo` time stretch (needs ffmpeg). With `seconds`, `seconds / speed` instead.
- **Chunking** (as upstream): a chunk ends at the first of `。、，,．.!！?？` or a line break once it has `chunk_min_chars` characters (`first_sentence_chunk_min_chars` for the first); a chunk still estimated over the model's limit is split again by sentences. No chunking with `seconds`. The chunks are spoken in order on the queue and joined.
- **Response:** the audio with the format's `Content-Type`, `Content-Disposition: attachment; filename="speech.<ext>"`, `X-Irodori-Seed` (the first chunk's seed) and `X-Irodori-Total-To-Decode` (seconds). mp3, flac, opus and aac need ffmpeg (`ffmpeg_unavailable`).
- **SSE:** one `audio_chunk` event per chunk, `{index, text, format, media_type, audio_base64, seed, total_to_decode}` (each a complete file), then `done` with `{chunks}`; a failure ends the stream with an `error` event carrying an OpenAI error body.
- **Errors:** OpenAI's shape `{"error": {message, type, param, code}}` with this app's error codes: `400` for the request's faults (unknown model or voice, parameters, text too long, …), `503` while the model is not loaded, `500` otherwise, `422` for a malformed body.

## External API — VOICEVOX compatible

Tools that speak the VOICEVOX Engine API (e.g. YMM4, AITuber tools, bots) use the app by pointing at its URL. Checked against the VOICEVOX Engine 0.25 OpenAPI; the deviations follow the table. Speaker names, style names and the policy text are Japanese protocol data, not UI copy.

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/speakers` | one speaker per library voice (`speaker_uuid`: a UUIDv5 of the voice id); styles `ノーマル` (the voice as saved) and, when the model takes captions, the ten style presets (a caption for manner and mood, as on the Quick screen) |
| GET | `/speaker_info?speaker_uuid=&resource_format=base64\|url` | the policy (incl. upstream's ethical restrictions), the app icon as portrait and style icons, no voice samples; `404` for an unknown speaker |
| POST | `/initialize_speaker?speaker=` | encodes the voice's clips for the model if they are not yet, and waits; `204` |
| GET | `/is_initialized_speaker?speaker=` | whether the voice's clips are encoded |
| POST | `/audio_query?text=&speaker=` | an AudioQuery with `accent_phrases: []` and the text in `kana` |
| POST | `/accent_phrases?text=&speaker=` | `[]` |
| POST | `/synthesis?speaker=` · `/cancellable_synthesis?speaker=` | body AudioQuery → WAV (16-bit) |
| POST | `/multi_synthesis?speaker=` | AudioQuery[] → zip of `001.wav`, `002.wav`, … |
| POST | `/connect_waves` | base64 WAVs of the same rate and channels → one WAV |
| GET | `/version` · `/core_versions` | the app version |
| GET | `/engine_manifest` | name `irodori-studio`, brand `Irodori`, 48 kHz; supported features: speed and volume only, `return_resource_url` |
| GET | `/supported_devices` | `{cpu: true, cuda: <running on CUDA>, dml: false}` |
| GET | `/presets` · `/user_dict` · `/singers` | empty (`[]`, `{}`, `[]`) |

- **Style ids** are stable 31-bit integers: the first 4 bytes of SHA-1 of `<voice id>:<style>` (a collision moves on to the next free id). They survive restarts and do not change when other voices come or go. An unknown style id is `422`.
- **AudioQuery:** Irodori reads text, not accent phrases. `/audio_query` keeps the text in `kana`; a query from another engine without `kana` is spoken from its moras' text. `speedScale` becomes `duration_scale` (as `speed` above), `volumeScale` a gain, `prePhonemeLength` / `postPhonemeLength` silence before and after, `outputSamplingRate` a resample (ffmpeg) and `outputStereo` two identical channels. `pitchScale`, `intonationScale`, `pauseLength`, `pauseLengthScale` and mora or accent edits are ignored.
- **Long text** is chunked as on the OpenAI route (80 characters).
- **Not provided:** editing the user dictionary or presets, morphing, singing, library management and the engine settings page. Errors are FastAPI's `{"detail": ...}`; this app's errors read `"<code>: <message>"`.
