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
class TtsBackend(Protocol):          # engine/base.py; no torch in its types
    def required_files(self, spec: ModelSpec, models_root: Path) -> dict[str, Path]: ...
    def load(self, spec: ModelSpec, options: RuntimeOptions, models_root: Path) -> None: ...
    def unload(self) -> None: ...
    watermark_ready: bool            # property: SilentCipher loaded (D12)
    def device_info(self) -> dict[str, object]: ...
    def encode_reference(self, clip: Path, dest: Path, *, normalize_db, ensure_max, max_seconds) -> None: ...
    def synthesize(self, request: BackendRequest, hooks: BackendHooks) -> BackendResult: ...
```

Capabilities come from the registry, not from the backend. `TorchBackend` builds an upstream `RuntimeKey` from local files (checkpoint + sibling tokenizer, codec `weights.pth`) → `InferenceRuntime.from_key(key)`, and maps a `BackendRequest` onto upstream `SamplingRequest` field by field (parameter names are identical to upstream; see `upstream-notes.md`). It also owns the two integration points upstream lacks (decisions.md, S2): the per-call watermark switch and a step hook around the model's `forward_with_encoded_conditions` for progress and cancellation (D27).

`RuntimeOptions` (require reload): device, model precision, codec device and precision, `compile_model`, `compile_dynamic`. `BackendRequest` (per call): text, caption, one speaker source (cached reference latents | speaker embedding | none), LoRA adapter path, the resolved sampling parameters, seed, and the watermark flag (computed by `watermark_policy`, D12). `BackendHooks` carry `on_log`, `on_progress(done, total)` and `is_cancelled`.

`EngineHost` (`engine/host.py`) loads the backend once in the background when the sidecar starts and reports `idle | loading | ready | error`; `SynthesisQueue` (`services/queue.py`) runs every job on one worker thread and waits while the model loads.

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

- Rust selects a free port on `127.0.0.1`, spawns `<venv-python> -m app.main --port <port>` (cwd = sidecar dir), polls `GET /health` (retrying on a new port if the sidecar exits early), and exposes status `setup → starting → loading_model → ready` (or `error`) to the frontend (`app://status`); `loading_model` lasts until `/health` reports the engine `ready` (D4).
- Teardown guard kills the process tree on window close, app quit, panic, and forced quit: every child (uv, provisioning scripts, sidecar) runs in its own kill-on-close Job Object (Windows) or process group (macOS); the sidecar also exits when the app's pid (`IRODORI_PARENT_PID`) disappears, which covers a forced quit on macOS. Children get a null stdin.
- Environment passed to the sidecar: `PYTHONPATH=<sidecar dir>[;<upstream dir>]`, `HF_HOME=<data-root>/models`, `HF_HUB_OFFLINE=1`, `HF_HUB_DISABLE_TELEMETRY=1`, `HF_HUB_DISABLE_SYMLINKS_WARNING=1`, `IRODORI_DATA_ROOT`, `IRODORI_LOG_DIR`, `IRODORI_DEVICE`, `IRODORI_PRECISION`, `IRODORI_APP_VERSION`, `IRODORI_PARENT_PID`, `IRODORI_ALLOWED_ORIGINS`, `IRODORI_FFMPEG` (when bundled), `PYTHONUTF8=1`, `PYTHONIOENCODING=utf-8`, `PYTHONPYCACHEPREFIX=<data-root>/runtime/pycache`; plus `CUDA_DEVICE_ORDER`/`CUDA_VISIBLE_DEVICES` with several GPUs and `PYTORCH_ENABLE_MPS_FALLBACK=1` on macOS. Inherited `UV_*`, `PYTHONHOME`, `PYTHONPATH`, `VIRTUAL_ENV`, `CONDA_PREFIX` and relocated HF cache variables are removed first.

## First-run setup (bootstrap)

Idempotent; each step reports progress via Tauri events (`setup://progress` snapshots, `setup://log` lines, `<data-root>/logs/setup.log`) and is retryable. Implemented in `src-tauri/src/bootstrap.rs` + `sidecar/app/provision/`.

Wizard (frontend, `src/features/setup/`):
1. **Language** (preselected from the OS; saved to settings).
2. **Terms** incl. upstream's ethical restrictions (D13; `TERMS_VERSION` in settings).
3. **Platform probe** (no torch yet, `platform/`):
   - Windows: `nvidia-smi --query-gpu=index,name,compute_cap,memory.total,driver_version --format=csv,noheader,nounits`. Policy (`platform/policy.rs`, D2/D7/D9): usable NVIDIA (compute capability ≥ 7.0, VRAM ≥ ~6 GB) → `cuda` (cu128, fp32 or bf16); otherwise `cpu` with a notice. The user may choose CPU mode explicitly.
   - macOS: `sysctl -n machdep.cpu.brand_string`, `sysctl -n hw.optional.arm64`, `sysctl -n hw.memsize`, `sw_vers -productVersion`. Apple Silicon → `mps` fp32 (M1 warns); Intel → blocked (D8).
4. **Data root** chosen by the user (D16), checked for writability and free space.
5. **Install**, the steps below.

Steps (each skipped when the marker shows it is current):
1. **Python**: bundled `uv` → `uv python install <.python-version> --no-bin --no-registry` into `<data-root>/runtime/python`.
2. **Venv**: `uv venv <data-root>/runtime/venv --managed-python --clear`.
3. **Deps**: `uv sync --frozen --no-dev --inexact` with `UV_PROJECT_ENVIRONMENT=<venv>` (locked, no torch). `irodori_tts` itself is not pip-installed (its metadata requires torch); processes get the pinned source on `PYTHONPATH`.
4. **Torch**: the recipe in `sidecar/upstream.json` for the plan's variant (cu128 / cpu index, or PyPI on macOS), then torchcodec from PyPI (D2).
5. **Models**: `python -m app.provision.download` — model + codec at their pinned commits into `<models>/pinned/...` with byte-level resume and hash verification; SilentCipher into the HF cache by branch. Bytes/total are reported.
6. **Verify**: `python -m app.provision.selfcheck --device <d>` — torch on the chosen device with a real kernel launch, and the upstream import through the adapter.

Wizard step 7, the test generation (synthesize and play one sentence), is a card on the ready screen once the model has loaded (Session 2; Session 3's Quick screen supersedes it). The marker (`<data-root>/runtime/setup.json`) records each finished step with the hashes of its inputs (`.python-version`, `uv.lock`, the torch recipe, `models.json`) and the device choice, so later launches skip setup entirely, an app update re-runs only the steps whose inputs changed, and switching CPU ⇄ GPU re-runs only the torch step.

## Storage layout

| Purpose | Location | Notes |
| --- | --- | --- |
| Settings | Tauri app config dir / `settings.json` | Rust only |
| Data root | user-selected | default `<local-app-data>/data` (not roaming) |
| Runtime | `<data-root>/runtime/` | `venv/` (recreated if broken), `python/` (uv-managed), `uv-cache/`, `pycache/`, `setup.json` marker |
| Models | `<data-root>/models` | `HF_HOME`; pinned repos in `pinned/<owner>--<name>/<commit>/`, SilentCipher in `hub/` |
| Database | `<data-root>/irodori-studio.db` | SQLite (WAL), sidecar-owned: preferences, history + audio, clips; migrations via `PRAGMA user_version` |
| Voices | `<data-root>/voices/<voice-id>/` | clips (flac), cached latents per model id, optional embedding |
| History audio | `<data-root>/history/<history-id>/<audio-id>.wav` | 48 kHz mono PCM16; pruned by D23 |
| Reference clips | `<data-root>/clips/<clip-id>/` | ad-hoc uploads: `audio.wav` (float32) + cached `latents/` per model setting |
| Projects | `<data-root>/projects/` | `.iroproj` |
| Exports | user-selected default | |
| Logs | `<data-root>/logs/` | `sidecar.log`, `setup.log`; rotated at 5 MB |

## Data flows

### Single generation (Quick / advanced)

1. Frontend `POST /tts/generate` → validated (text, reference, parameters against the capability schema) → `{job_id, queue_position}`.
2. SSE `GET /jobs/{id}/events`: `queued` → `started` → `log` / `progress` (sampling steps) … → `candidate` (per candidate, with `audio_id`) → `completed {history_id, used_seed, timings, outputs}`.
3. Reference resolution: clips (and library voices, Session 4) → cached latents for the active model (encoded on a miss); an embedding path is passed through.
4. Text pipeline: user dictionary (Session 5) → upstream (which normalizes internally).
5. Result written to history (audio + request as submitted + resolved parameters + seed + timings), then pruned to the limits.

### Narration

`POST /narration/split` (preview chunks, reading hints) → user edits → `POST /narration/render` (job). Chunks are synthesized sequentially through the queue; events report `chunk_done {index, audio_id}`. Voice lock (D18) captures chunk 1's audio as the reference for the rest. Final assembly: concatenate with configured pauses → post-process → export + SRT/VTT built from chunk durations. Per-chunk regenerate re-runs one chunk and re-assembles.

### Script

`POST /script/parse` (text or CSV → rows) → user assigns speakers to voices → `POST /script/render` (job; per-line candidates). Adopted takes → per-line files (naming template) and/or merged drama audio + subtitles.

### External API request

Request on the external listener → `compat/openai.py` or `compat/voicevox.py` → translate to `SynthesisRequest` → same queue → encode to requested format via `audio/export.py` → response. Voice ids map to library voices; VOICEVOX speaker/style ids are stable integers stored per voice (and per caption preset → style).

## Watermark policy (D12)

`services/policy.py::watermark_policy(request, settings) -> bool` is the only place deciding whether the watermark is applied. Default returns `settings.watermark_enabled` (sidecar `Preferences`, default true). The `OPEN` owner decision may add "force True when a reference or speaker embedding is used" (`FORCE_WATERMARK_FOR_CLONING`). When the policy says off, the adapter skips upstream's watermark stage for that call; when it says on and SilentCipher did not load, the job fails with `watermark_unavailable` instead of silently producing unwatermarked audio.

## Update check (D15)

Rust `update_check` → `GET https://api.github.com/repos/<owner>/<repo>/releases/latest` with a short timeout; compare semver with the app version; emit an event the frontend shows as a dismissible banner. Disabled in Settings or offline → no-op.

## Platform-specific handling

- **Windows:** UTF-8 forced (cp932 mitigation); HF symlink warning suppressed; Job Object for teardown; SmartScreen note in README.
- **macOS:** arm64 only; ad-hoc signing of the app and bundled binaries; microphone permission string; MPS fp32; `PYTORCH_ENABLE_MPS_FALLBACK=1` so unsupported ops fall back to CPU instead of crashing (log when it happens).

## Error & status surfaces

- `GET /health` (liveness + engine state), `GET /system` (device, memory, torch/CUDA/MPS versions, active model, upstream sha, queue length).
- Errors are `{code, message, detail}`; `code` is stable and translated by the frontend.
- All sidecar stdout/stderr tee'd to `logs/` and viewable in Settings.
