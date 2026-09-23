# API specification

Single source of truth for the sidecar HTTP contracts. Keep these three in sync in the same change: this file, `src/lib/types.ts`, `sidecar/app/schemas.py` (see `coding-conventions.md`).

Two listeners (D21):
- **Internal API** — `http://127.0.0.1:<random>`; used only by the app UI. No auth (localhost, random port).
- **External API** — optional; `<bind>:<port>` (default `127.0.0.1:50221`); OpenAI- and VOICEVOX-compatible routes for other apps. Bearer API key required when bound to a non-loopback address.

Status of this document: **v0 draft**. Shapes below are the intended contract; refine field-by-field during the session that implements each router and update this file in the same change.

---

## Conventions

- JSON, UTF-8, `snake_case`.
- Errors: HTTP 4xx/5xx with body `{"code": "string", "message": "string", "detail": {}}`. `code` values are stable and listed in `sidecar/app/errors.py`; the frontend translates them.
- Long-running operations return `202 {"job_id": "...", "queue_position": 0}`; follow with SSE.
- IDs are ULIDs (sortable).

## Common types

```ts
type ReferenceInput =
  | { kind: "none" }
  | { kind: "voice"; voice_id: string }              // library voice (clips or embedding)
  | { kind: "clips"; clip_ids: string[] }            // uploaded ad-hoc clips, ordered
  | { kind: "embedding"; path: string };             // .speaker.safetensors

type SamplingParams = {             // names mirror upstream SamplingRequest; all optional → capability defaults
  num_steps?: number;               // 1–120, default 40
  num_candidates?: number;          // 1–32, default 1
  seed?: number | null;             // null = random
  seconds?: number | null;          // null = duration predictor
  duration_scale?: number;          // 0.5–1.5, default 1.0
  t_schedule_mode?: "linear" | "sway";
  sway_coeff?: number;              // -1.0–1.5, default -1.0 (only when sway)
  cfg_guidance_mode?: "independent" | "joint" | "alternating";
  cfg_scale_text?: number;          // 0–10, default 3.0
  cfg_scale_caption?: number;       // 0–10, default 4.0 (Space)
  cfg_scale_speaker?: number;       // 0–10, default 5.0
  cfg_scale?: number | null;        // deprecated shared override
  cfg_min_t?: number;               // default 0.5
  cfg_max_t?: number;               // default 1.0
  context_kv_cache?: boolean;       // default true
  max_text_len?: number | null;
  max_caption_len?: number | null;
  truncation_factor?: number | null;
  rescale_k?: number | null;        // set together with rescale_sigma
  rescale_sigma?: number | null;
  speaker_kv_scale?: number | null;
  speaker_kv_min_t?: number | null; // default 0.9 when scale set
  speaker_kv_max_layers?: number | null;
  speaker_uncond_mode?: "mask" | "noise"; // embedding only
  ref_normalize_db?: number | null; // default -16.0; null = off
  ref_ensure_max?: boolean;         // default true
  max_ref_seconds?: number | null;  // default from capabilities (120)
  decode_mode?: "sequential" | "batch";
  trim_tail?: boolean;              // default true
};

type SynthesisRequest = {
  text: string;                     // Japanese; may contain emoji annotations
  caption?: string | null;
  reference: ReferenceInput;
  lora_adapter?: string | null;     // directory path
  params?: SamplingParams;
  apply_dictionary?: boolean;       // default true
};

type Timings = Record<string, number>; // ms per stage, e.g. predict_duration, sample_rf, decode_latent, watermark
```

---

## Internal API

### System & lifecycle
| Method | Path | Notes |
| --- | --- | --- |
| GET | `/health` | `{status: "ok"}`; does not require a loaded model |
| GET | `/system` | device, memory (VRAM or unified), torch/CUDA/MPS versions, active model id, upstream sha, queue length, watermark available |
| POST | `/system/cache/clear` | free accelerator cache |

### Models
| Method | Path | Notes |
| --- | --- | --- |
| GET | `/models` | registry entries + download state + size on disk |
| POST | `/models/{id}/download` | job; progress in bytes |
| DELETE | `/models/{id}` | remove files (not the active one) |
| POST | `/models/load` | `{model_id, runtime: {device, model_precision, codec_precision, compile_model, compile_dynamic}}` → job |
| POST | `/models/unload` | |
| GET | `/models/active/capabilities` | parameter schema for the UI (see `architecture.md` → Parameter schema) |
| GET | `/emoji` | emoji palette derived from upstream (`symbol`, `meaning_key`, `category`) |

### Generation & jobs
| Method | Path | Notes |
| --- | --- | --- |
| POST | `/tts/generate` | body `SynthesisRequest` → 202 job |
| GET | `/jobs/{id}/events` | SSE (below) |
| POST | `/jobs/{id}/cancel` | cancels queued or (cooperatively) running work (D27) |
| GET | `/queue` | current queue snapshot (UI + external) |
| GET | `/audio/{audio_id}` | wav stream (48 kHz) |

SSE event types: `queued {position}`, `started`, `log {line}`, `progress {done, total, unit: "candidate"|"chunk"|"line"}`, `candidate {index, audio_id, duration_s}`, `chunk_done {index, audio_id}`, `completed {history_id?, used_seed, timings, outputs[]}`, `failed {code, message}`, `cancelled`.

### Text
| Method | Path | Notes |
| --- | --- | --- |
| POST | `/text/reading` | `{text}` → tokens with estimated kana + dictionary hits (hint only, D19) |
| GET / PUT | `/dictionary` | `[{surface, reading, enabled, note}]` |

### Voices
| Method | Path | Notes |
| --- | --- | --- |
| GET | `/voices` | list |
| POST | `/voices` | create `{name, source: "designed"|"imported"|"recorded"|"embedding", caption_default?, params_default?, seed_default?, consent?}`; consent required for imported/recorded (D13) |
| GET / PUT / DELETE | `/voices/{id}` | |
| POST | `/voices/{id}/clips` | multipart upload (wav/flac/mp3/m4a/ogg/opus/webm) |
| PUT | `/voices/{id}/clips/order` | ordered clip ids |
| POST | `/voices/{id}/clips/{clip_id}/trim` | `{start_s, end_s}` |
| POST | `/voices/{id}/clips/{clip_id}/split` | `{at_s[]}` |
| DELETE | `/voices/{id}/clips/{clip_id}` | |
| POST | `/voices/{id}/encode` | job; caches latent for the active model |
| POST | `/voices/{id}/embedding` | upload `.speaker.safetensors` |
| POST | `/voices/design` | `{caption, sample_text, params}` → job with N candidates; `POST /voices` from an adopted candidate |
| GET | `/voices/{id}/export` | `.irovoice` (D22) |
| POST | `/voices/import` | `.irovoice` upload |

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

### Export, history, presets, projects
| Method | Path | Notes |
| --- | --- | --- |
| POST | `/export` | `{audio_ids[] | history_id, format: wav|mp3|flac|opus|aac, sample_rate: 48000|44100, loudness?: -14|-16|-23|null, tempo?: number, gain_db?: number, dest_dir, naming_template}` |
| GET | `/history` | paged, filters (text, voice, date) |
| GET / DELETE | `/history/{id}` | includes full request + seed + timings |
| POST | `/history/{id}/regenerate` | job with identical request (seed optional) |
| GET / PUT | `/history/settings` | `{max_entries, max_bytes}` |
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
