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
- Zustand stores (memory only): `app` (boot, status, port), `nav` (active screen), `sidecar` (API client, capabilities, emoji palette, preferences, polled system/engine status), `quick` (Quick screen form and job), `voices` (library, Voice Studio drafts and jobs), `narration` (manuscript, settings draft, render job, reading previews), `script` (import text, open script, settings draft, render job, file-name preview), `library` (history filters, page, selection, regenerate jobs), `presets`, `projects` (what an opened project left out), `apiServer` (the external listener's configuration, status and styles), `settings` (what Rust reports for Settings, the runtime's licenses, the open tab); `app` also holds the update check and the data root move. Job state shared by screens (`lib/jobs.ts`) is advanced by SSE events outside React, so jobs keep updating on other screens.
- **Capability-driven parameter UI.** The parameter panel is generated from `GET /models/active/capabilities` (a JSON schema-like list of parameters with type, range, default, group, `simple|advanced` tier, `visible_when`). No component hardcodes which parameters a model supports.
- i18n via `react-i18next` (D17). Locale JSON under `src/i18n/locales/<locale>/`. Sidecar errors arrive as codes and are translated in the frontend.
- Audio: playback via `<audio>` with blob URLs fetched from `/audio/{id}`; waveform editing (trim/split) with `wavesurfer.js` (regions plugin).
- Microphone recording via `MediaRecorder` in the WebView; the recorded blob is uploaded to the sidecar. (Tauri needs the macOS microphone usage description in `Info.plist`.)

### Tauri core (Rust)

Modules (one responsibility each): `layout` (dev vs installed paths), `paths`, `config` (settings.json), `platform` (`windows.rs`: nvidia-smi probe, junctions; `macos.rs`: chip, macOS version, memory; both: opening folders and links, HTTP through the system curl), `bootstrap` (first-run steps, idempotent, progress events, repair), `sidecar` (port, spawn, health, teardown guard), `update_check` (GitHub Releases API), `relocate` (moving the data root), `logs` (log tails), `commands`.

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

- Rust selects a free port on `127.0.0.1`, spawns `<venv-python> -m app.main --port <port>` (cwd = sidecar dir), polls `GET /health` (retrying on a new port if the sidecar exits early), and exposes status `setup → starting → loading_model → ready` (or `error`; `moving` while the data root moves) to the frontend (`app://status`); `loading_model` lasts until `/health` reports the engine `ready` (D4).
- Teardown guard kills the process tree on window close, app quit, panic, and forced quit: every child (uv, provisioning scripts, sidecar) runs in its own kill-on-close Job Object (Windows) or process group (macOS); the sidecar also exits when the app's pid (`IRODORI_PARENT_PID`) disappears, which covers a forced quit on macOS. Children get a null stdin.
- Environment passed to the sidecar: `PYTHONPATH=<sidecar dir>[;<upstream dir>]`, `HF_HOME=<data-root>/models`, `HF_HUB_OFFLINE=1`, `HF_HUB_DISABLE_TELEMETRY=1`, `HF_HUB_DISABLE_SYMLINKS_WARNING=1`, `IRODORI_DATA_ROOT`, `IRODORI_LOG_DIR`, `IRODORI_DEVICE`, `IRODORI_PRECISION`, `IRODORI_APP_VERSION`, `IRODORI_PARENT_PID`, `IRODORI_ALLOWED_ORIGINS`, `IRODORI_FFMPEG` (the bundled LGPL build; in dev, an ffmpeg on PATH), `PYTHONUTF8=1`, `PYTHONIOENCODING=utf-8`, `PYTHONPYCACHEPREFIX=<data-root>/runtime/pycache`; plus `CUDA_DEVICE_ORDER`/`CUDA_VISIBLE_DEVICES` with several GPUs and `PYTORCH_ENABLE_MPS_FALLBACK=1` on macOS. Inherited `UV_*`, `PYTHONHOME`, `PYTHONPATH`, `VIRTUAL_ENV`, `CONDA_PREFIX` and relocated HF cache variables are removed first.

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

Wizard step 7, the test generation (synthesize and play one sentence), is the Quick screen itself: it opens with a sample sentence once the model has loaded (Session 3). The marker (`<data-root>/runtime/setup.json`) records each finished step with the hashes of its inputs (`.python-version`, `uv.lock`, the torch recipe, `models.json`) and the device choice, so later launches skip setup entirely, an app update re-runs only the steps whose inputs changed, and switching CPU ⇄ GPU re-runs only the torch step.

## Storage layout

| Purpose | Location | Notes |
| --- | --- | --- |
| Settings | Tauri app config dir / `settings.json` | Rust only |
| Data root | user-selected | default `<local-app-data>/data` (not roaming) |
| Runtime | `<data-root>/runtime/` | `venv/` (recreated if broken), `python/` (uv-managed), `uv-cache/`, `pycache/`, `setup.json` marker |
| Models | `<data-root>/models` | `HF_HOME`; pinned repos in `pinned/<owner>--<name>/<commit>/`, SilentCipher in `hub/` |
| Database | `<data-root>/irodori-studio.db` | SQLite (WAL), sidecar-owned: preferences (incl. export settings), history + audio, clips, voices, dictionary, narrations, scripts, presets; migrations via `PRAGMA user_version` |
| Voices | `<data-root>/voices/<voice-id>/` | `voice.speaker.safetensors` for embedding voices; the rest of a voice is database rows and its clips |
| History audio | `<data-root>/history/<history-id>/<audio-id>.wav` | 48 kHz mono PCM16; pruned by D23 |
| Narration audio | `<data-root>/narrations/<narration-id>/<audio-id>.wav` | chunk takes and the joined file; deleted with the narration, never pruned |
| Script audio | `<data-root>/scripts/<script-id>/<audio-id>.wav` | line takes and the merged drama; deleted with the script, never pruned |
| Reference clips | `<data-root>/clips/<clip-id>/` | ad-hoc uploads and library voices' clips: `audio.wav` (float32) + cached `latents/` per model setting; unowned clips are purged after a day |
| Projects | `<data-root>/projects/` | default place for `.iroproj` files (created at start): `project.json` + adopted takes as FLAC |
| Exports | user-selected default | |
| Logs | `<data-root>/logs/` | `sidecar.log`, `setup.log`; rotated at 5 MB |

## Data flows

### Single generation (Quick / advanced)

1. Frontend `POST /tts/generate` → validated (text, reference, parameters against the capability schema) → `{job_id, queue_position}`.
2. SSE `GET /jobs/{id}/events`: `queued` → `started` → `log` / `progress` (sampling steps) … → `candidate` (per candidate, with `audio_id`) → `completed {history_id, used_seed, timings, outputs}`.
3. Reference resolution: clips or a library voice's clips → cached latents for the active model (encoded on a miss; library voices are encoded when saved); an embedding (a voice's or an ad-hoc path) is passed as a `.speaker.safetensors` file.
4. Text pipeline: user dictionary (longest match first, `apply_dictionary`) → upstream (which normalizes internally).
5. Result written to history (audio + request as submitted + resolved parameters + seed + timings), then pruned to the limits.

### Voice library (Voice Studio)

1. Clips are uploaded (`POST /clips`, origin `upload` / `recording`) or come from a generated candidate; trim and split replace a clip with new ones.
2. `POST /voices` / `PATCH /voices/{id}` / `POST /voices/import` validate the voice (consent for real voices, D13) and assign the ordered clips; clips a voice no longer lists are deleted.
3. If a clip lacks latents for the active model, an `encode` job joins the synthesis queue (D24) and streams `progress {unit: "clip"}`; `Voice.encoded` turns true.
4. Generating with `{kind: "voice"}` reads the cached latents (or the voice's embedding); the caller applies the voice's defaults.

### Narration

`POST /narrations` splits the manuscript (text, Markdown or SRT/WebVTT; `text/chunker.py`, estimates from `text/reading.py`) and stores the chunks → the user edits chunk texts, previews readings (`POST /text/reading`) and the dictionary → `POST /narrations/{id}/render` queues one `narration` job that synthesizes the chunks needing a take in order (`SynthesisService.prepare` + `synthesize`, the same path as single generations), emitting `chunk {index, takes}` and chunk progress; cancelling keeps finished chunks and a new render resumes. Voice lock (D18) turns chunk 1's adopted take into the reference clip of the rest. `POST /narrations/{id}/assemble` trims each adopted take's silence and joins them with the configured pauses (or at SRT cue times) into one WAV with exact subtitle cues; `/export` writes it in the chosen format plus SRT/VTT and optional per-chunk files. Per-chunk redo (`render {indices, redo}`) adds a take; any take can be adopted again.

### Script

`POST /scripts` parses "話者：セリフ" text or a CSV / TSV table (`text/script_parser.py`) into lines with stable ids and derives the speakers → the user maps speakers to library voices (plus a caption per speaker), edits lines in the table (text, caption, candidates, seed, pause, file name; insert, delete, move) → `POST /scripts/{id}/render` queues one `script` job that synthesizes the lines needing a take in order through the same `SynthesisService` path, each request built from voice defaults < script parameters < line values, emitting `line {line_id, takes}` and line progress. Takes are `audio` rows keyed by `script_id` + `line_id` (`services/takes.py`, shared with narration), so they follow their line through edits; new text or another speaker discards a line's takes. `/assemble` joins the adopted takes with each line's pause into one WAV with speaker-tagged cues; `/export` writes one file per line named by the template (previewed via `/file-names`), the merged drama and SRT/VTT into a folder; `/table` writes the lines back as CSV / TSV that `POST /scripts` reads unchanged.


### Export and post-processing (D20)

Every export — `/audio/{id}/save`, narration and script exports, `/history/export` — goes through `audio/export.py`: a WAV without post-processing is copied; any other format or `post` option runs ffmpeg once per file with the filter chain from `audio/post.py` (`atempo`, then a two-pass `loudnorm` measured first, or `volume`) and the output sample rate. Many files (per line, per chunk, several history entries) are encoded four at a time. Subtitle cues are moved by the tempo. The UI keeps one set of export settings in preferences.

### Library, presets, projects

The Library screen pages `/history` with filters (`voice_id` is recorded per entry), plays and adopts candidates, and acts on entries: `/history/{id}/regenerate` resubmits the stored request (a new entry), "use these settings" loads it into the Quick store, `/history/export` writes adopted candidates with a naming template (`text/naming.py`, shared with script exports). Presets (`services/presets.py`) are stored parameter sets that the parameter panels load and save. Projects (`services/projects.py`) serialize a narration or script with its adopted takes into `.iroproj` and restore it through `NarrationService.restore` / `ScriptService.restore` and `TakeStore.restore` (16-bit samples written back unchanged).
### External API request

`services/api_server.py` runs the second uvicorn server (`compat/server.py` builds its app: API key check, request log, CORS, error shapes) and binds its port first, so a port in use is a status. A request → `compat/openai.py` or `compat/voicevox.py` → `compat/speech.py`: the voice's defaults under the request's values, `speed` / `speedScale` split into `duration_scale` and a residual time stretch, chunking, one `SynthesisRequest` per chunk submitted with `source: "api"` to the same queue and awaited through the job's events (cancelled if the client goes away) → the chunks joined and encoded (WAV / PCM in numpy, other formats and post-processing via `audio/export.py`) → response, or one SSE event per chunk. Voice ids and names map to library voices; VOICEVOX speakers are voices and styles the voice as saved plus the style presets (`compat/styles.py`), with ids hashed from voice id and style.

## Watermark policy (D12)

`services/policy.py::watermark_policy(request, settings) -> bool` is the only place deciding whether the watermark is applied. Default returns `settings.watermark_enabled` (sidecar `Preferences`, default true). The `OPEN` owner decision may add "force True when a reference or speaker embedding is used" (`FORCE_WATERMARK_FOR_CLONING`). When the policy says off, the adapter skips upstream's watermark stage for that call; when it says on and SilentCipher did not load, the job fails with `watermark_unavailable` instead of silently producing unwatermarked audio.

## Update check (D15)

Rust `update_check` → `GET https://api.github.com/repos/<owner>/<repo>/releases/latest` through the system's curl (Windows 10+ and macOS ship it; no TLS stack bundled), 8 s timeout, three seconds after startup when enabled and the terms are accepted; compare semver with the app version; emit `app://update`, which the frontend shows as a dismissible banner (open the release page, skip this version). A 404 (nothing published yet) means nothing is newer; offline or other failures are silent at startup and reported by a manual check in Settings. Only this app's Releases page is ever opened.

## Settings (Session 9)

- **Runtime override (D9):** `settings.json` `runtime: {device, precision}` over the setup plan, applied through `IRODORI_DEVICE` / `IRODORI_PRECISION` when the sidecar starts; the choices follow the installed torch (a CUDA build also runs on the CPU, the macOS wheels on MPS or the CPU, a CPU build only on the CPU; bf16 only on CUDA with an Ampere or newer GPU). Applying restarts the sidecar.
- **Data root move (D16):** `relocate` stops the sidecar, scans the root (not following links) without the rebuildable caches (`runtime/uv-cache`, `runtime/pycache`), checks the target (empty or new, not inside or around the current root, writable, space for the copy plus 512 MB), copies (links are recreated, rebased into the new root: junctions on Windows, symlinks on macOS), verifies every entry and the database byte for byte, relinks the runtime venv with the bundled uv (`uv venv --allow-existing --managed-python --no-python-downloads`, which rewrites `pyvenv.cfg` and the absolute interpreter path in the `python.exe` trampoline / `bin/` links), checks that the moved venv runs entirely from the new root, switches `settings.json`, and starts the sidecar. Any failure removes the copy and starts from the old root; a start failure after the switch switches back. Progress streams as `app://move` while the app shows the move screen. The old root stays until the user deletes it from Settings (only a folder that looks like a data root and does not overlap the current one).
- **Repair:** clears the marker's dependency, model and self-check entries and returns to the setup wizard, which resumes at once: `uv sync` (a no-op when nothing is missing), the model downloader (which now checks every complete file against the Hub's hash and fetches damaged ones again), the self-check, then the sidecar.
- **Logs:** Rust reads the last 256 KB of `sidecar.log` / `setup.log` (also on the error screen, when the sidecar is down); folders open in Explorer / Finder.

## Packaging (Session 10)

- **Resources:** `scripts/stage-runtime.ps1` (Windows) / `stage-runtime.sh` (macOS) fill `resources/`: `sidecar/` (the sidecar's `app/`, `pyproject.toml`, `uv.lock`, `.python-version`, `models.json`, `upstream.json`, and the pinned `irodori_tts` package with its LICENSE next to `app/`, unmodified), `uv/` (uv 0.12.5, checksum-pinned), `ffmpeg/` (an LGPL build with its license and `BUILD.txt`: build, checksum, configuration, source). Downloads and builds stay in `.stage/`. `tauri.conf.json` bundles `resources/` as the resource folder, plus `LICENSE.txt` and `THIRD_PARTY_NOTICES.md`.
- **Installed layout (`layout.rs`):** through `BaseDirectory::Resource`, `sidecar/` is both the sidecar directory and the `PYTHONPATH` entry for `irodori_tts`; `uv/uv(.exe)` and `ffmpeg/ffmpeg(.exe)` are used, never an ffmpeg on PATH. A build made on the development machine still finds the repo (`CARGO_MANIFEST_DIR`); `IRODORI_FORCE_BUNDLED=1` tests the installed layout there.
- **Bundle hooks:** `beforeBuildCommand` builds the frontend. After the Rust build, `beforeBundleCommand` runs `scripts/gen-licenses.mjs` — `cargo metadata --offline --filter-platform <host>` → `resources/licenses/rust-crates.md`: every crate compiled into the app with version, license and copyright lines, the license files of crates not used under MIT or Apache-2.0, and both of those texts — and `scripts/check-staged.mjs`, which refuses to bundle an unstaged `resources/`.
- **Installers (D14):** Windows NSIS, per user (`%LOCALAPPDATA%\irodori-studio`), in Japanese, English, Simplified Chinese and German; macOS arm64 dmg signed ad hoc, with uv and ffmpeg signed ad hoc by the stage script. Uninstalling removes the app; the storage folder and settings stay (README explains removing them).
- **FFmpeg (D20):** `scripts/build-ffmpeg.sh` builds the audio-only LGPL ffmpeg (FFmpeg + LAME + Opus, static, no other external library); `.github/workflows/ffmpeg.yml`, run by hand when its versions change, builds it for both platforms and publishes the zips with their source archives on a prerelease, from which the stage scripts download them by checksum (until the first run: BtbN's LGPL build on Windows, the source build in `stage-runtime.sh` on macOS).
- **Release workflow:** `.github/workflows/release.yml`, on a `v*` tag or by hand: one job per platform — checkout with submodules, Node 24, stable Rust, `npm ci`, stage, `tauri build --bundles nsis|dmg`, the installer as a workflow artifact and, for a tag, attached to a draft GitHub Release to review and publish.

## Platform-specific handling

- **Windows:** UTF-8 forced (cp932 mitigation); HF symlink warning suppressed; Job Object for teardown; SmartScreen note in README.
- **macOS:** arm64 only; ad-hoc signing of the app and bundled binaries; microphone permission string; MPS fp32; `PYTORCH_ENABLE_MPS_FALLBACK=1` so unsupported ops fall back to CPU instead of crashing (log when it happens).

## Error & status surfaces

- `GET /health` (liveness + engine state), `GET /system` (device, memory, torch/CUDA/MPS versions, active model, upstream sha, queue length).
- A GPU failure mid-generation (`device_lost`) leaves the engine in `error`; a banner offers to restart the sidecar. A write that fails for lack of space is `disk_full`.
- The error screen (startup failed) offers retry, repair, and the log.
- Errors are `{code, message, detail}`; `code` is stable and translated by the frontend.
- All sidecar stdout/stderr tee'd to `logs/` and viewable in Settings.
