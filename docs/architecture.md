# Architecture

System architecture and process model for `irodori-studio`. Decisions referenced as `Dn` live in `decisions.md`.

## High-level

```
┌──────────────────────────────────────────────────────────────────────┐
│ Tauri 2 application (single window)                                   │
│                                                                       │
│  ┌──────────────────────────────┐  invoke   ┌──────────────────────┐ │
│  │ Next.js frontend (WebView)    │ ────────► │ Tauri core (Rust)     │ │
│  │  7 screens, i18n (ja/en/zh/de)│ ◄──────── │  - process manager    │ │
│  └──────────────┬───────────────┘ commands  │  - bootstrap / setup  │ │
│                 │                            │  - platform probe     │ │
│                 │ HTTP + SSE                 │  - settings.json      │ │
│                 │ 127.0.0.1:<random>         │  - update check       │ │
│                 ▼                            └──────────┬───────────┘ │
│  ┌──────────────────────────────────────────────────────▼──────────┐ │
│  │ Python sidecar (uv-managed child process)                         │ │
│  │  uvicorn #1  internal API  (127.0.0.1:<random>)  ← app UI         │ │
│  │  uvicorn #2  external API  (<bind>:<port>, optional) ← other apps │ │
│  │                                                                   │ │
│  │  app/                                                             │ │
│  │   ├─ routers/        thin HTTP layer                              │ │
│  │   ├─ compat/         OpenAI + VOICEVOX adapters (external API)    │ │
│  │   ├─ services/       jobs, queue, voices, narration, script, ...  │ │
│  │   ├─ text/           dictionary, reading, chunker, srt            │ │
│  │   ├─ audio/          export, post-processing (ffmpeg)             │ │
│  │   ├─ storage/        SQLite + file store                          │ │
│  │   └─ engine/                                                      │ │
│  │        ├─ base.py            TtsBackend protocol (D6)             │ │
│  │        ├─ registry.py        models.json + capabilities (D5)      │ │
│  │        └─ irodori_adapter.py TorchBackend → upstream (D3)         │ │
│  │                                   │                               │ │
│  │  third_party/Irodori-TTS (submodule, pinned, untouched)  ◄────────┘ │
│  └───────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────┘
```

The frontend never talks to upstream directly. Rust owns lifecycle and settings; it does not proxy API calls (D10).

## Components

### Frontend (Next.js, static export)

- `output: 'export'`; served by Tauri. No runtime Node server (D11).
- Base URL of the internal API from the `get_sidecar_port` Tauri command. No port literals.
- Zustand stores: `sidecar`, `model` (active model + capabilities), `jobs`, `queue`, `settings`, `voices`, `narration`, `script`.
- **Capability-driven parameter UI.** The parameter panel is generated from `GET /models/active/capabilities` (a JSON schema-like list of parameters with type, range, default, group, `simple|advanced` tier, `visible_when`). No component hardcodes which parameters a model supports.
- i18n via `react-i18next` (D17). Locale JSON under `src/i18n/locales/<locale>/`. Sidecar errors arrive as codes and are translated in the frontend.
- Audio: playback via `<audio>` with blob URLs fetched from `/audio/{id}`; waveform editing (trim/split) with `wavesurfer.js` (regions plugin).
- Microphone recording via `MediaRecorder` in the WebView; the recorded blob is uploaded to the sidecar. (Tauri needs the macOS microphone usage description in `Info.plist`.)

### Tauri core (Rust)

Modules (one responsibility each): `layout` (dev vs installed paths), `paths`, `config` (settings.json), `platform` (`windows.rs`: nvidia-smi probe; `macos.rs`: chip, macOS version, memory), `bootstrap` (first-run steps, idempotent, progress events), `sidecar` (port, spawn, health, teardown guard), `update_check` (GitHub Releases API), `commands`.

### Python sidecar

- Python 3.10 (upstream `.python-version`, confirmed in S0), managed by uv. The sidecar is a uv virtual project: dependencies come from `sidecar/uv.lock` (no torch), and `irodori_tts` is imported from the pinned source via `PYTHONPATH` (decisions.md, S0).
- Two uvicorn servers in one process sharing one `EngineHost` singleton (resident model, D4) and one `SynthesisQueue` (D24).
- All upstream access goes through `engine/irodori_adapter.py` (D3).

## Engine layer

### TtsBackend protocol (D6)

```python
class TtsBackend(Protocol):
    def load(self, model: ModelSpec, runtime: RuntimeOptions) -> None: ...
    def unload(self) -> None: ...
    def capabilities(self) -> Capabilities: ...
    def device_info(self) -> DeviceInfo: ...
    def encode_reference(self, clips: list[Path]) -> ReferenceLatent: ...
    def synthesize(self, req: SynthesisRequest, on_log: Callable[[str], None]) -> SynthesisResult: ...
```

`TorchBackend` builds an upstream `RuntimeKey(checkpoint, model_device, codec_repo, model_precision, codec_device, codec_precision, ...)` → `InferenceRuntime.from_key(key)` and maps our `SynthesisRequest` onto upstream `SamplingRequest` field by field (names are kept identical to upstream where possible; see `upstream-notes.md`).

`RuntimeOptions` (require reload): device, precision (model/codec), `compile_model`, `compile_dynamic`. `SynthesisRequest` (per call): text, caption, reference (none | clips | cached latent | speaker embedding), LoRA adapter path, all sampling params, `num_candidates`, seed, watermark flag (computed by `watermark_policy`, D12).

### Model registry (D5)

`sidecar/models.json`:

```json
{
  "schema": 1,
  "models": [
    {
      "id": "irodori-v4.1-small",
      "display_name": "Irodori-TTS v4.1 Small",
      "hf_repo": "Aratako/Irodori-TTS-v4.1-Small",
      "hf_revision": "<pinned sha>",
      "codec_repo": "Aratako/Semantic-DACVAE-Japanese-32dim",
      "codec_revision": "<pinned sha>",
      "size_bytes_approx": 3500000000,
      "tier": "default",
      "capabilities": {
        "caption": true,
        "speaker_reference": true,
        "speaker_embedding": true,
        "lora": true,
        "duration_predictor": true,
        "max_ref_seconds": 120,
        "max_output_seconds": 30,
        "sampling": "rf",
        "ignores": []
      },
      "requirements": {
        "cuda_vram_fp32_gb": 6.0,
        "cuda_vram_bf16_gb": 5.0,
        "mps_unified_memory_gb": 8
      }
    }
  ]
}
```

Adding Large = one entry + submodule bump. A MeanFlow model would declare `"sampling": "meanflow", "ignores": ["cfg", "sway"]`, and the parameter schema hides those controls automatically.

### Parameter schema

`engine/params.py` holds one table describing every parameter (name, type, default, range/choices, group, tier, requires capability, maps-to upstream field). It feeds: pydantic validation, `GET /models/active/capabilities`, and the frontend panel. Defaults follow the HF Space (D26).

## Process model & port selection

- Rust selects a free port on `127.0.0.1`, spawns `<venv-python> -m app.main --port <port> --data-root <dir> ...`, polls `GET /health`, exposes status `setup → starting → loading_model → ready → error`.
- Teardown guard kills the process tree on window close, app quit, panic, and forced quit (Windows Job Object; macOS process group).
- Environment passed to the sidecar: `HF_HOME=<data-root>/models`, `IRODORI_DATA_ROOT`, `IRODORI_FFMPEG`, `IRODORI_LOG_DIR`, `PYTHONUTF8=1`, `PYTHONIOENCODING=utf-8`, `HF_HUB_DISABLE_SYMLINKS_WARNING=1`.

## First-run setup (bootstrap)

Idempotent; each step reports progress via Tauri events and is retryable with visible logs.

1. **Language + terms** (frontend only; stored in settings).
2. **Platform probe** (no torch yet):
   - Windows: `nvidia-smi --query-gpu=name,compute_cap,memory.total --format=csv,noheader`. Map to `cuda` (cu128) or `cpu` (D2, D7, D9).
   - macOS: `sysctl -n machdep.cpu.brand_string`, `sw_vers -productVersion`, `sysctl -n hw.memsize`. M2+ → `mps`; M1 → `mps` + warning; Intel → unsupported (D8).
   - Free disk space at the chosen data root.
3. **Data root** chosen by the user (D16).
4. **Python + venv**: bundled `uv` → `uv python install <ver>` → `uv venv <data-root>/runtime/venv`.
5. **Base deps**: install the sidecar's locked dependencies (`sidecar/uv.lock`, no torch). `irodori_tts` itself is not pip-installed (its metadata requires torch); the sidecar process gets the pinned source on `PYTHONPATH`.
6. **Torch**: platform-specific index (D2).
7. **Models**: download the active model, codec, tokenizer assets, and SilentCipher files into `HF_HOME` via `huggingface_hub` with resume. Show bytes/total.
8. **Smoke test**: load model, synthesize a short sentence, play it.

On later launches, completed steps are detected (marker file with versions: app, upstream sha, torch variant) and skipped. An app update that bumps the upstream sha re-runs step 5 only.

## Storage layout

| Purpose | Location | Notes |
| --- | --- | --- |
| Settings | Tauri app config dir / `settings.json` | Rust only |
| Data root | user-selected | default `<app-data>/data` |
| Runtime venv | `<data-root>/runtime/venv` | recreated if broken |
| Models (HF cache) | `<data-root>/models` | `HF_HOME` |
| Database | `<data-root>/irodori-studio.db` | SQLite, sidecar-owned |
| Voices | `<data-root>/voices/<voice-id>/` | clips (flac), cached latents per model id, optional embedding |
| History audio | `<data-root>/history/` | pruned by D23 |
| Projects | `<data-root>/projects/` | `.iroproj` |
| Exports | user-selected default | |
| Logs | `<data-root>/logs/` | sidecar + bootstrap logs, rotated |

## Data flows

### Single generation (Quick / advanced)

1. Frontend `POST /tts/generate` → `{job_id, queue_position}`.
2. SSE `GET /jobs/{id}/events`: `queued` → `started` → `log` … → `candidate` (per candidate, with `audio_id`) → `completed {history_id, used_seed, timings}`.
3. Voice resolution: voice id → cached latent for the active model (encode on miss) or embedding path.
4. Text pipeline: user dictionary → upstream (which normalizes internally).
5. Result written to history (audio + request + seed + timings).

### Narration

`POST /narration/split` (preview chunks, reading hints) → user edits → `POST /narration/render` (job). Chunks are synthesized sequentially through the queue; events report `chunk_done {index, audio_id}`. Voice lock (D18) captures chunk 1's audio as the reference for the rest. Final assembly: concatenate with configured pauses → post-process → export + SRT/VTT built from chunk durations. Per-chunk regenerate re-runs one chunk and re-assembles.

### Script

`POST /script/parse` (text or CSV → rows) → user assigns speakers to voices → `POST /script/render` (job; per-line candidates). Adopted takes → per-line files (naming template) and/or merged drama audio + subtitles.

### External API request

Request on the external listener → `compat/openai.py` or `compat/voicevox.py` → translate to `SynthesisRequest` → same queue → encode to requested format via `audio/export.py` → response. Voice ids map to library voices; VOICEVOX speaker/style ids are stable integers stored per voice (and per caption preset → style).

## Watermark policy (D12)

`services/policy.py::watermark_policy(request, settings) -> bool` is the only place deciding whether the watermark is applied. Default returns `settings.watermark_enabled`. The `OPEN` owner decision may add "force True when a reference or speaker embedding is used".

## Update check (D15)

Rust `update_check` → `GET https://api.github.com/repos/<owner>/<repo>/releases/latest` with a short timeout; compare semver with the app version; emit an event the frontend shows as a dismissible banner. Disabled in Settings or offline → no-op.

## Platform-specific handling

- **Windows:** UTF-8 forced (cp932 mitigation); HF symlink warning suppressed; Job Object for teardown; SmartScreen note in README.
- **macOS:** arm64 only; ad-hoc signing of the app and bundled binaries; microphone permission string; MPS fp32; `PYTORCH_ENABLE_MPS_FALLBACK=1` so unsupported ops fall back to CPU instead of crashing (log when it happens).

## Error & status surfaces

- `GET /health` (liveness), `GET /system` (device, memory, torch/CUDA/MPS versions, active model, upstream sha, queue length).
- Errors are `{code, message, detail}`; `code` is stable and translated by the frontend.
- All sidecar stdout/stderr tee'd to `logs/` and viewable in Settings.
