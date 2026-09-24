# API specification

Single source of truth for the sidecar HTTP contracts. Keep these three in sync in the same change: this file, `src/lib/types.ts`, `sidecar/app/schemas.py` (see `coding-conventions.md`).

Two listeners (D21):
- **Internal API** — `http://127.0.0.1:<random>`; used only by the app UI. No auth (localhost, random port).
- **External API** — optional; `<bind>:<port>` (default `127.0.0.1:50221`); OpenAI- and VOICEVOX-compatible routes for other apps. Bearer API key required when bound to a non-loopback address.

Status of this document: **v0 draft**. Shapes below are the intended contract; refine field-by-field during the session that implements each router and update this file in the same change. Implemented so far: system (S1); models, generation & jobs, clips, basic history and preferences (S2); engine runtime in `/health`, adopting a candidate and saving a copy (S3); clip editing and the voice library with encode jobs and `.irovoice` packages (S4).

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
  apply_dictionary?: boolean;       // default true (dictionary: Session 5)
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
| POST | `/audio/{audio_id}/save` | `{path, format?: "wav"\|"mp3"\|"m4a"\|"flac"\|"opus"}` (absolute path from the native save dialog; without `format`, the extension decides, else WAV; the format's extension is applied; an existing file is replaced) → `{path, bytes, format}`. Formats other than WAV are encoded by ffmpeg (MP3 VBR ≈ 190 kbps, M4A AAC 192 kbps, FLAC, Opus 128 kbps): `400 ffmpeg_unavailable` without it; `400 save_path_invalid` / `save_failed`. Sample rate, loudness, tempo, gain: `POST /export` (S7) |

```ts
type JobAccepted = { job_id: string; queue_position: number }; // jobs ahead of this one
type AudioOutput = { index: number; audio_id: string; duration_s: number };
type TtsResult = { history_id: string; used_seed: number; timings: Timings; outputs: AudioOutput[]; watermarked: boolean };
type EncodeResult = { voice_id: string; encoded: number }; // clips encoded by an "encode" job
type JobInfo = {
  job_id: string; kind: "tts" | "encode";
  state: "queued" | "running" | "completed" | "failed" | "cancelled";
  queue_position: number | null;       // while queued
  created_at: string; started_at: string | null; finished_at: string | null;
  error: { code: string; message: string } | null;
  result: TtsResult | EncodeResult | null;
};
type QueueItem = { job_id: string; kind: "tts" | "encode"; source: "ui" | "api"; state: "queued" | "running"; created_at: string };
type QueueSnapshot = { running: QueueItem | null; queued: QueueItem[] };
```

SSE (`text/event-stream`): each event has `event: <type>`, `id: <sequence number>` and one JSON `data:` line. A new subscriber first receives the job's past events, so subscribing late loses nothing; the stream ends after the terminal event, and a reconnect with `Last-Event-ID` resumes after that event.

| Event | Data |
| --- | --- |
| `queued` | `{position}`: on submit and whenever the position changes |
| `started` | `{}` |
| `log` | `{line}`: upstream and sidecar log lines (developer text) |
| `progress` | `{done, total, unit}`: `unit` is `"step"` (sampling steps) for single generations, `"clip"` for encode jobs (after each clip); `"chunk"` / `"line"` for narration and script jobs later |
| `candidate` | `AudioOutput`, one per candidate, before `completed` |
| `completed` | `TtsResult`, or `EncodeResult` for an encode job (terminal) |
| `failed` | `{code, message}` (terminal) |
| `cancelled` | `{}` (terminal) |

A single generation streams `queued → started → log / progress … → candidate × N → completed`; an encode job `queued → started → log / progress (unit "clip") … → completed`. Failures detected only at run time include `watermark_unavailable` (the watermark is on but SilentCipher did not load, D12), `model_load_failed` / `model_files_missing`, `out_of_memory`, `invalid_params` (rejected upstream) and `synthesis_failed`.

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

### History (basic) & preferences
| Method | Path | Notes |
| --- | --- | --- |
| GET | `/history` | `?limit=1–200 (50)&offset=0&q=` → `{items: HistorySummary[], total}`, newest first; `q` matches text or caption |
| GET / DELETE | `/history/{id}` | `HistoryEntry`: the request as submitted, every resolved parameter, seed and timings; DELETE also removes its audio |
| PATCH | `/history/{id}` | `{adopted_audio_id: string \| null}` adopts one of its candidates (or clears it) → `HistoryEntry`; `404 audio_not_found` for another entry's audio |
| POST | `/history/{id}/regenerate` | job with identical request (seed optional) |
| GET / PATCH | `/preferences` | `Preferences`; PATCH takes any subset of the fields |

```ts
type HistorySummary = {
  id: string; created_at: string; model_id: string; text: string; caption: string | null;
  reference_kind: "none" | "voice" | "clips" | "embedding";
  used_seed: number; watermarked: boolean; outputs: AudioOutput[];
  adopted_audio_id: string | null;     // the candidate the user adopted (requirements §6.3)
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
};
```

### Text
| Method | Path | Notes |
| --- | --- | --- |
| POST | `/text/reading` | `{text}` → tokens with estimated kana + dictionary hits (hint only, D19) |
| GET / PUT | `/dictionary` | `[{surface, reading, enabled, note}]` |

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
| Method | Path | Notes |
| --- | --- | --- |
| POST | `/narration/split` | `{text | srt, rules: {min_chars, max_chars, split_on}, apply_dictionary}` → chunks with reading hints and estimated seconds |
| POST | `/narration/render` | `{chunks[], voice/reference, caption?, params, pauses: {sentence_ms, paragraph_ms}, voice_lock, srt_timing?}` → job |
| POST | `/narration/{render_id}/chunks/{index}/regenerate` | job |
| POST | `/narration/{render_id}/assemble` | `{adopted: {index: audio_id}}` → assembled audio + subtitle ids |

### Script
| Method | Path | Notes |
| --- | --- | --- |
| POST | `/script/parse` | `{text}` ("話者：セリフ") or `{csv, delimiter}` → rows |
| POST | `/script/render` | `{rows[], speaker_map: {speaker: voice_id}, defaults}` → job |
| POST | `/script/{render_id}/lines/{index}/regenerate` | job |
| POST | `/script/{render_id}/export` | `{mode: "per_line"|"merged"|"both", naming_template, pause_ms, subtitles}` |

### Export, history filters, presets, projects
| Method | Path | Notes |
| --- | --- | --- |
| POST | `/export` | `{audio_ids[] | history_id, format: wav|mp3|flac|opus|aac, sample_rate: 48000|44100, loudness?: -14|-16|-23|null, tempo?: number, gain_db?: number, dest_dir, naming_template}` |
| GET | `/history` | voice and date filters on top of the S2 endpoint (Session 7) |
| GET / POST / DELETE | `/presets` | named `SamplingParams` sets |
| POST | `/projects/save` · `/projects/open` | `.iroproj` (D23) |

### External API control
| Method | Path | Notes |
| --- | --- | --- |
| GET / PUT | `/api-server/config` | `{enabled, bind: "127.0.0.1"|"0.0.0.0", port, api_key?, families: ["openai","voicevox"]}` |
| GET | `/api-server/status` | running, url, recent requests |

---

## External API — OpenAI compatible

Modeled on upstream `Aratako/Irodori-TTS-Server` so its clients work unchanged.

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/v1/models` | `[{id: "irodori-tts"}]` |
| POST | `/v1/audio/speech` | `{model, input, voice?, response_format?: wav|mp3|flac|opus|aac|pcm, speed?: 0.25–4.0, stream_format?: "sse", irodori?: {...SamplingParams, caption?, chunking_enabled?, chunk_min_chars?}}` |
| GET | `/v1/audio/voices` | library voices (id = voice slug); `none` = no reference |

`speed` maps to `duration_scale = 1/speed` (clamped to the capability range; beyond it, apply post time-stretch). Long input is chunked (D18) and concatenated; `stream_format: "sse"` emits one `audio_chunk` event per chunk then `done`.

## External API — VOICEVOX compatible

Goal: tools that speak the VOICEVOX Engine API (e.g. YMM4, AITuber tools, bots) can use the app by pointing at its URL. Verify each route against the VOICEVOX Engine OpenAPI during Session 8 and record deviations here.

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/version` | app version |
| GET | `/engine_manifest` | name, brand, supported features (minimal) |
| GET | `/speakers` | one speaker per voice; styles = the voice's caption presets (style ids stable ints) |
| GET | `/speaker_info` | icon/portrait placeholders, policy text incl. ethical restrictions |
| POST | `/initialize_speaker` · GET `/is_initialized_speaker` | ensure cached latent exists |
| POST | `/audio_query` | returns an AudioQuery; Irodori does not use accent phrases → `accent_phrases: []`, original text kept in `kana`; `speedScale`→`duration_scale`, `volumeScale`→gain, `prePhonemeLength`/`postPhonemeLength`→silence padding, `outputSamplingRate` honored; `pitchScale`/`intonationScale` ignored |
| POST | `/synthesis?speaker=<style_id>` | body AudioQuery → wav |
| GET | `/supported_devices` | reflects actual device |
