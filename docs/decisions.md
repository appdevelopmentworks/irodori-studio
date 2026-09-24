# Architecture decision records

Locked decisions and their rationale. **Do not re-litigate these while coding.** If you believe one is wrong, flag it for the owner rather than changing course silently.

Status legend: `LOCKED` (decided by the owner), `CONFIRM` (default chosen, owner may still override — build it so the override is cheap), `OPEN` (resolve during implementation and record the outcome under "Resolved during implementation").

---

### D1 — Sidecar is a uv-managed child process, not a frozen binary  `LOCKED`
Same model as `qwen-tts-desktop`. Rust spawns the venv's uvicorn as a child process. Installed builds bundle the sidecar **source** + a platform `uv` binary + a platform `ffmpeg` binary as Tauri resources; the venv is created under `<app-data>/runtime/venv` (writable) on first run. Dev vs installed layout is auto-detected in `src-tauri/src/layout.rs`.
**Why:** reproducible, fast to iterate, identical on Windows and macOS, and avoids PyInstaller + CUDA packaging pain. Torch and models are downloaded at first run anyway (they exceed the 2 GB GitHub Release asset limit).

### D2 — `torch` is not pinned; installed per platform at first run  `LOCKED`
`sidecar/pyproject.toml` pins everything except `torch` / `torchaudio` (and `torchvision` if pulled in). First-run setup installs:
- Windows + NVIDIA → CUDA 12.8 wheels (`https://download.pytorch.org/whl/cu128`). Upstream Irodori-TTS also standardizes on cu128.
- Windows without a usable NVIDIA GPU → CPU wheels (`/whl/cpu`).
- macOS arm64 → default PyPI wheels (include MPS).
**Why:** the correct wheel depends on the machine; a static pin cannot express this. RTX 50 (Blackwell, sm_120) requires cu128.
**Sub-item `OPEN`:** confirm the minimum compute capability covered by the cu128 wheels of the pinned torch version (expected Turing sm_75+). Anything below → CPU mode with a notice.

### D3 — Upstream is a commit-pinned git submodule, never edited  `LOCKED`
`third_party/Irodori-TTS` is a git submodule pinned to a specific commit. The sidecar imports `irodori_tts` from it (path dependency or `PYTHONPATH`). Release builds copy the pinned `irodori_tts/` package into the bundled sidecar resources, so end users never need git.
All app behavior lives in `sidecar/app/`; upstream is reached only through `sidecar/app/engine/irodori_adapter.py`.
**Why:** owner chose "commit-pinned git dependency + adapter layer". Upgrading (e.g. for Large) = bump the submodule commit + re-run the adapter tests. If a capability is not exposed by upstream, raise it; do not patch upstream.
**Sub-item `OPEN` (Session 0):** inspect upstream `pyproject.toml`. If `torch` is a base dependency there, install upstream's non-torch deps explicitly in our pyproject rather than letting the resolver pull a generic torch.

### D4 — Model residency: load once, stay resident  `LOCKED`
After setup completes, the sidecar loads the active model at startup (~16 s cold load) and keeps it resident. Manual unload / reload from Settings. Switching model or runtime-level settings (device, precision, compile) triggers a reload.
**Why:** per-request loading would dominate latency (load ≈ 16 s vs generation ≈ 1 s on a 4090).

### D5 — Model policy: top model only, driven by a capability registry  `LOCKED` (sub-items `CONFIRM`)
Only the top official checkpoint is offered (today: `Aratako/Irodori-TTS-v4.1-Small`). Models are declared in `sidecar/models.json` with capabilities (see `architecture.md` → Model registry). The UI renders parameters from capabilities, never from hardcoded model names.
- `CONFIRM`: when Large ships, keep Small selectable as the low-spec option (default Large where hardware allows).
- `CONFIRM`: MF (MeanFlow) and quantized variants are **not** offered. Low-memory handling = bf16 + fewer steps. The registry format must still be able to express them (e.g. `ignores: ["cfg", "sway"]`) so adding one later is data-only.
**Why:** owner answer "最上位のモデルのみ" + maintainability for the forthcoming Large.

### D6 — Inference backend interface with an MLX slot  `LOCKED`
`sidecar/app/engine/base.py` defines a `TtsBackend` protocol (load / unload / synthesize / encode_reference / capabilities / device_info). v1 ships one implementation, `TorchBackend` (devices: `cuda` / `mps` / `cpu`), wrapping upstream `InferenceRuntime`. `MlxBackend` is a reserved name only — no code in v1.
**Why:** owner wants MLX swappable later without touching routers or UI.

### D7 — Windows device policy: NVIDIA GPU, else explicit CPU mode  `LOCKED`
Probe with `nvidia-smi` before torch exists. Usable NVIDIA → CUDA. Otherwise → CPU mode, shown clearly in the setup wizard and status bar ("CPU mode: generation is slow"). Never fall back silently.
**Why:** owner chose "NVIDIA + CPU fallback" (differs from qwen-tts-desktop, which rejected CPU).

### D8 — macOS policy: Apple Silicon M2+, PyTorch MPS fp32  `LOCKED` (M1 handling `CONFIRM`)
arm64-only build. Target M2 and newer. `CONFIRM`: M1 is allowed with an "unsupported" warning rather than blocked. Intel Macs are unsupported (arm64 bundle will not run).
MPS uses fp32 for model and codec (upstream guidance; bf16 on MPS was measured slower by community reports). If a component misbehaves on MPS, fall back per component (upstream supports separate `codec_device`), recorded in the registry/device policy — not with ad-hoc code.

### D9 — Minimum requirements and precision policy  `CONFIRM`
- Windows NVIDIA: VRAM ≥ 8 GB → fp32 (upstream default); 6–8 GB → bf16 automatically (Ampere+ only); < 6 GB → CPU mode.
- macOS: 16 GB unified memory recommended; 8 GB allowed with a warning.
- Precision and device are user-overridable in Settings (advanced).
**Why:** measured ≈ 5.4 GB VRAM at fp32 and ≈ 4.9 GB at bf16 on a 4090 for short text.

### D10 — Transport: HTTP + SSE on a random localhost port; job-based work  `LOCKED`
Same as qwen-tts-desktop: Rust picks a free port on `127.0.0.1`, spawns the sidecar, frontend obtains it via `get_sidecar_port` and calls the sidecar directly (Rust does not proxy). Long-running work returns `job_id`; progress via `GET /jobs/{id}/events` (SSE); cancel via `POST /jobs/{id}/cancel`.

### D11 — Next.js static export; no browser storage  `LOCKED`
`output: 'export'`. No `localStorage` / `sessionStorage` / IndexedDB for app state. Settings through Tauri commands; data through the sidecar.

### D12 — Watermark: default ON, user can turn it OFF  `LOCKED` (scope of OFF `OPEN`)
SilentCipher watermarking is applied by default. A Settings toggle can disable it.
`OPEN` (owner to decide): whether the toggle is ignored (watermark forced ON) when the generation uses reference audio or a speaker embedding (i.e. voice cloning). Implement the rule in exactly one function, `watermark_policy(request, settings) -> bool`, so either answer is a one-line change.
**Sub-item `OPEN` (Session 2):** find how upstream applies the watermark (inside `InferenceRuntime.synthesize` when the dependency/model files are present). Determine the cleanest supported way to skip it without editing upstream (runtime flag, constructor option, or calling a lower-level API). Record the finding here. → Resolved in S2 ("S2 — D12 sub-item" below).

### D13 — Consent gating and first-run terms  `LOCKED`
First run requires accepting terms that include upstream's ethical restrictions. Creating a voice from imported or recorded audio requires a consent confirmation that is stored with the voice (`consent: {confirmed_at, statement}`) and exported inside voice packages.

### D14 — Distribution: GitHub Releases, unsigned  `LOCKED`
Windows: NSIS installer. macOS: `.dmg`, arm64, **ad-hoc signed** (`signingIdentity: "-"`; Apple Silicon refuses to run unsigned arm64 code) but not notarized. README documents first-launch approval: macOS `xattr -dr com.apple.quarantine "/Applications/<App>.app"`; Windows SmartScreen "More info → Run anyway". Bundled `uv` / `ffmpeg` binaries are ad-hoc signed too.
**Sub-item `OPEN` (Session 10):** verify files downloaded by the app at first run (venv, torch, models) are not quarantined and need no extra steps.

### D15 — Updates: notification only  `CONFIRM`
On startup (if online and enabled), query the GitHub Releases API for the latest tag; if newer, show a non-blocking notice linking to the Releases page. No Tauri updater in v1.

### D16 — Storage  `LOCKED`
- `settings.json` owned by Rust (Tauri app config dir).
- Data root chosen by the user at first run; subdirs: `models/` (HF cache, `HF_HOME`), `runtime/` (venv), `voices/`, `history/`, `projects/`, `exports/`, `logs/`.
- Metadata in SQLite (`<data-root>/irodori-studio.db`) owned by the sidecar. Audio lives as files; the DB stores relative paths.
- "Move data root" in Settings copies, verifies, then switches.

### D17 — i18n: react-i18next, four locales  `LOCKED` (Chinese variant `CONFIRM`)
Locales: `ja` (source of truth), `en`, `zh-Hans` (`CONFIRM`: simplified), `de`. Keys are English identifiers; every visible string goes through `t()`. Missing-key check runs in CI. Emoji palette labels and error messages from the sidecar are localized too (sidecar returns error **codes**, the frontend maps them to text).
Note: the TTS model itself accepts Japanese text only; the UI says so in every locale.

### D18 — Long-text chunking and voice consistency  `CONFIRM`
Split on sentence punctuation / newlines with a target of 80–150 characters per chunk (configurable), never exceeding the ~30 s per-generation limit (upstream trained max ≈ 750 latent frames at 25 fps). Pauses: separate silence lengths after sentences and paragraphs.
Voice consistency: without a reference, each chunk may produce a different voice. Therefore narration requires a voice with reference audio or a speaker embedding; for caption-only voices the UI offers **Voice lock** = synthesize chunk 1, then reuse its audio as the reference for all following chunks.

### D19 — Reading dictionary and reading preview  `CONFIRM` (library `OPEN`)
User dictionary (surface → reading) is applied before sending text to upstream (upstream then applies its own normalization). Reading preview shows analyzer-estimated kana; it is a hint, not a guarantee of what the model will say.
`OPEN`: choose the analyzer (candidate: `pyopenjtalk-plus` for prebuilt Win/macOS wheels; alternative: `fugashi` + `unidic-lite`). Check license and wheel availability.

### D20 — Output formats and post-processing via bundled ffmpeg  `CONFIRM`
wav written natively (48 kHz); mp3 / flac / opus / aac and 44.1 kHz resampling via bundled ffmpeg. Loudness presets via `loudnorm` (-14 / -16 / -23 LUFS). Speed: model `duration_scale` by default; optional post time-stretch (`atempo`) for exact timing. Gain. No pitch shifting in v1.
Use an **LGPL** ffmpeg build for public distribution and ship its license + source pointer in third-party notices.

### D21 — External API: one configurable port, OpenAI + VOICEVOX compatible  `CONFIRM`
A second listener inside the same sidecar process, enabled from the API Server screen. Default port `50221` (avoids VOICEVOX 50021 and AivisSpeech 10101), bound to `127.0.0.1`; LAN binding requires an API key. Serves OpenAI-compatible routes under `/v1/...` and VOICEVOX-compatible routes at the root. Shares the single resident model and the synthesis queue (D24). Gradio compatibility is out of v1.

### D22 — Voice package format  `CONFIRM`
`.irovoice` = zip containing `voice.json` (name, defaults, consent, source type, model id it was made with) + reference clips (flac) + optional `.speaker.safetensors`. Cached latents are **not** exported (recomputed on import, model-specific).

### D23 — History and projects  `CONFIRM`
History: every generation stores audio + full request + used seed + timings. Pruning by count and size (defaults 500 entries / 5 GB). Projects: `.iroproj` = zip with `project.json` (narration or script, settings, chunk/line state, adopted take ids) + adopted audio.

### D24 — Single synthesis queue  `LOCKED`
One synthesis at a time across the UI and the external API (FIFO). Queue position is reported to both. UI jobs and API requests are cancellable while queued.

### D25 — Naming and license  `OPEN` / `CONFIRM`
Working name `irodori-studio` for folder and identifiers. Public display name `OPEN` — must not imply it is the official Irodori-TTS app (e.g. "<Name> for Irodori-TTS"). App license `CONFIRM`: MIT.

### D26 — Default parameter values follow the HF Space  `CONFIRM`
Where the Space and the CLI defaults differ, use the Space (the owner's parity target). Known difference: `cfg_scale_caption` is 4.0 in the Space vs 3.0 in the CLI docs. Full table in `upstream-notes.md`.

### D27 — Progress and cancellation granularity  `OPEN`
Upstream `InferenceRuntime.synthesize` exposes a `log_fn` but no per-step progress or cancel hook (verify at the pinned commit). v1 reports progress per request / per chunk / per line and cancels cooperatively between units. Mid-sampling cancel is `OPEN`; do not patch upstream for it. → Resolved in S2 ("S2 — D27" below).

---

## Resolved during implementation

### S0 — D3: upstream pin
`third_party/Irodori-TTS` is pinned to `89f9d8fbd4d51ea019867ee1197725ede1df13c5` (upstream `main`, 2026-09-12, "Add MeanFlow distillation and v4-Large support"). Bump it only in its own commit (`chore(upstream): bump Irodori-TTS to <sha>`) and update `upstream-notes.md`.

### S0 — D3 sub-item: upstream dependencies
Upstream `pyproject.toml` declares `torch>=2.10.0`, `torchaudio>=2.10.0`, `torchcodec>=0.10.0,<0.11.0` and `torchdata>=0.11.0` as **base** dependencies (its `cpu`/`cu128`/`rocm`/`xpu` extras pin torch 2.10.x + torchao 0.16.x). Upstream `.python-version` is `3.10`. Outcome:
- `sidecar/pyproject.toml` lists upstream's non-torch runtime deps explicitly, pinned to the versions in upstream's `uv.lock` at the pinned commit: `dacvae` (commit `414c207…`), `silentcipher` (commit `d46d7d0…`), `huggingface-hub==1.23.0`, `llvmlite==0.46.0`, `numba==0.63.1`, `peft==0.18.1`, `pyyaml==6.0.3`, `safetensors==0.7.0`, `sentencepiece==0.1.99`, `soundfile==0.13.1`, `tqdm==4.67.3`, `transformers==5.12.1`; plus `fastapi`, `uvicorn`, `python-multipart` (pinned). Python `>=3.10,<3.11`.
- Not installed: `datasets`, `wandb`, `torchdata` (training only; the `irodori_tts` package never imports them) and `gradio` (imported only by `irodori_tts/gradio_emoji_palette.py`). Consequence for Session 3: read the palette constant `EMOJI_PALETTE_ITEMS` without importing that module (e.g. parse it with `ast` in the adapter) or add `gradio` then.
- The torch family (`torch`, `torchaudio`, `torchcodec`, `torchvision`, `torchao`, `torchdata`) is removed from resolution with never-true `override-dependencies` — needed because `dacvae`, `silentcipher`, `peft`/`accelerate`, `descript-audiotools`, `julius` and `torch-stoi` all require torch — and `[tool.uv] environments` is limited to win32/darwin/linux so `uv.lock` records no torch version at all. `sidecar/tests/test_dependency_policy.py` enforces this and D3's single import site.
- Upstream is **not installed as a distribution** (its metadata requires torch). The sidecar is a uv virtual project (`package = false`); `irodori_tts` is imported from the submodule via `PYTHONPATH` (pytest `pythonpath` now; Rust `layout.rs` from Session 1; installed builds copy `irodori_tts/` next to `app/`).
- `dacvae` and `silentcipher` are fetched as GitHub commit **archives** (`/archive/<sha>.tar.gz`) instead of `git+` URLs: first-run setup on an end-user machine cannot assume a `git` executable. Risk: if GitHub ever regenerates archive bytes, the lock hash check fails — Session 10 can stage the two sdists/wheels into `resources/` to remove the network dependency.

### S0 — Implementation notes
- Bundle identifier `com.aileap.irodori-studio` (follows qwen-tts-desktop); `productName` is the working name. Settle the identifier before the first public release: it determines the app-data and config paths, so changing it later strands users' settings.
- Frontend toolchain pins: TypeScript 6.0.x (typescript-eslint supports `<6.1`) and ESLint 9.x (eslint-plugin-react, pulled in by eslint-config-next, does not support ESLint 10 yet). Revisit when those ranges widen.

### S1 — D2 sub-item: cu128 minimum compute capability and the torch recipe
- Measured on the installed wheel: `torch 2.10.0+cu128` (Windows) reports `torch.cuda.get_arch_list()` = `sm_70 … sm_120`. Minimum is therefore **Volta (7.0)**, not Turing; anything older → CPU mode with the `gpu_too_old` notice (`platform/policy.rs::MIN_CUDA_CAPABILITY`).
- Torch is still never pinned in `pyproject.toml`/`uv.lock` (D2). First-run setup installs upstream's tested combination from its extras at the pinned commit: `torch==2.10.*` + `torchaudio==2.10.*` from `download.pytorch.org/whl/cu128` (or `/cpu`), then `torchcodec==0.10.*` **from PyPI** (the PyTorch indexes carry no Windows torchcodec wheel); macOS takes all three from PyPI. The recipe is data in `sidecar/upstream.json`; `tests/test_manifests.py` fails if it drifts from upstream's `cu128` extra.
- Switching CPU ⇄ CUDA keeps the version number, so the torch step always passes `--reinstall-package torch/torchaudio`; the uv cache makes switching back take seconds.

### S1 — D9 details (device policy)
- VRAM classes use nvidia-smi MiB with tolerance: ≥ 7,680 MiB = "8 GB class" → fp32; ≥ 5,632 MiB = "6 GB class" → bf16 on Ampere+ (`low_vram_bf16`), **fp32 with a `low_vram_fp32` warning on Turing/Volta** (no fast bf16); below → CPU (`vram_too_low`). Driver major < 570 → `driver_update_recommended` (informational). With several GPUs the largest usable one is chosen via `CUDA_DEVICE_ORDER=PCI_BUS_ID` + `CUDA_VISIBLE_DEVICES`.
- CPU mode is an explicit choice in the wizard ("Use CPU mode"), stored as `settings.device = "cpu"`, and always carries the `cpu_mode_slow` notice (wizard and ready screen).

### S1 — Setup, storage and lifecycle decisions
- **Default data root** is the *local* app data dir (`app_local_data_dir()/data`, i.e. `%LOCALAPPDATA%\com.aileap.irodori-studio\data` on Windows): many GB must not roam. Everything setup creates lives under the data root — venv, uv's cache (`UV_CACHE_DIR`), uv-managed Python (`UV_PYTHON_INSTALL_DIR`, installed with `--no-bin --no-registry`), bytecode cache, models, logs — so deleting that folder removes it all.
- **Setup marker** `<data-root>/runtime/setup.json` records each step as it finishes (python, deps hash of `uv.lock`, torch recipe hash + variant, models hash of `models.json`, device choice, `verified_at`); a relaunch skips finished steps, and an app update that changes `uv.lock` re-runs only the dependency step. `uv sync --frozen --no-dev --inexact` with `UV_PROJECT_ENVIRONMENT` installs the locked deps; a self-check (torch on the chosen device incl. a real kernel launch, and the upstream import through the adapter) must pass before the marker counts as complete.
- **Model files**: huggingface_hub 1.23 (pinned by upstream) cannot resume — every attempt writes a new uniquely named temp file, and a hard kill leaves it orphaned. Pinned model and codec repos are therefore downloaded by our own resumable fetcher into `<models>/pinned/<owner>--<name>/<commit>/…` (HTTP Range continuation of `<file>.part`, sha256 / git-blob verification, atomic rename); Session 2 passes these local paths to upstream. SilentCipher stays in the Hugging Face cache, fetched by branch `main` (verified commit recorded as `expected_commit`), because upstream loads it with `snapshot_download("sony/silentcipher")`. Stale cache temp files are removed at the start of each download.
- **Offline sidecar**: after setup the sidecar runs with `HF_HUB_OFFLINE=1` (and telemetry disabled); requirements §4/§7 — network only for setup, update checks and the opt-in API.
- **Sidecar lifetime** (golden rule 4): every child runs in its own kill-on-close job object (Windows) or process group (macOS). The sidecar additionally watches the app's pid (`IRODORI_PARENT_PID`): `WaitForSingleObject` on Windows, a 1 s liveness poll on macOS, which covers a forced quit there. A blocking read on the sidecar's stdin was tried first and rejected: on Windows a pending read on the stdin pipe deadlocks `import torch` in another thread.
- **CORS**: the internal API accepts only the app's own WebView origins. A per-launch auth token for the internal API (defence against local cross-site requests) is a possible hardening for the owner to consider; it would change the "no auth" note in `api-spec.md`.
- **[mac] acceptance pending**: no Mac was available in S1 (requirements §11 #21). The macOS probe, policy (unit-tested) and process-group code compile in CI's macOS job, but "M2 → MPS, setup completes" and "M1 shows the warning" are unverified on hardware.

### S2 — D12 sub-item: skipping the watermark
Finding at the pinned commit: `InferenceRuntime.__init__` creates `SilentCipherWatermarker(device=codec_device)`, and every `synthesize` applies it after decoding when `runtime.watermarker.ready` (stage `silentcipher_watermark`). There is no runtime flag or constructor option; if SilentCipher fails to load, upstream only logs a warning and returns unwatermarked audio. Outcome:
- **OFF:** for exactly that call the adapter swaps `runtime.watermarker` for a disabled stand-in (`ready = False`) and restores it afterwards (the single queue serializes calls); upstream's "watermark is unavailable" warning is dropped for such calls. No upstream edit, no second runtime.
- **ON but SilentCipher not loaded:** the job fails with `watermark_unavailable` and `GET /system` lists the issue, so default ON never lapses silently.
- The toggle is `Preferences.watermark_enabled` (sidecar database, below); `services/policy.py::watermark_policy()` still makes the decision. Requirements §11 #4 option B is `FORCE_WATERMARK_FOR_CLONING = True` (one line).

### S2 — D27: progress and cancellation
Verified at the pinned commit: `synthesize` takes only `log_fn`; `sample_euler_rf_cfg` and `sample_euler_meanflow` have no callback. Outcome:
- After loading, the adapter wraps the model's `forward_with_encoded_conditions` instance attribute once — the attribute upstream itself replaces for torch.compile, and (by code reading; no LoRA adapter was at hand to test) the one LoRA's `PeftModel` forwards attribute lookups to. Every sampling step has its own strictly decreasing `t`, so a new `t` marks a new step: the wrapper emits `progress {done, total, unit: "step"}` and checks for cancellation there.
- Cancelling a running job raises `SynthesisCancelled` inside sampling; upstream's lock, LoRA context and inference mode unwind normally and the next request works (GPU smoke test). Measured on an RTX 5090: cancel requested at step 10/120 → `cancelled` 52 ms later. Outside sampling (reference encode, duration prediction, decode, watermark: each < 0.2 s on a GPU) cancellation is checked between stages, and a result that completes anyway is discarded. Queued jobs are removed immediately.
- If an upstream bump changes this call path, progress stops arriving and cancellation degrades to between stages; `test_progress_and_cancel_mid_sampling` (marker `gpu`) catches that.

### S2 — Engine, jobs and storage
- **Model load (D4):** the sidecar starts loading the default model as soon as it serves; `GET /health` reports `engine.state` (`loading → ready | error`). Rust shows `loading_model` between `starting` and `ready` and fails with `model_load_failed` (detail = the sidecar's code, e.g. `model_files_missing`) or `model_load_timeout` (15 min). Jobs submitted meanwhile wait in the queue.
- **Upstream loading:** `InferenceRuntime.from_key` on local paths (`model.safetensors` with its sibling `tokenizer/`, codec `weights.pth`) — no network — and not through `get_cached_runtime`, because `EngineHost` owns residency. At load the adapter checks that every parameter-table name is a `SamplingRequest` field (`upstream_incompatible` otherwise).
- **Runtime options** come from the setup marker: model precision = the plan's (bf16 only on CUDA); the codec runs on the model's device and always in fp32 (small, and the audio path is where precision is audible).
- **Parameters:** `engine/params.py` is the single table (32 per-request parameters with Space defaults, including upstream's `tail_*` trim settings for CLI parity). It drives validation and `GET /models/active/capabilities`; `capabilities.param_defaults` (per-model defaults) and `ignores` tags (`cfg`, `sway`, `speaker_kv`) keep MeanFlow or Large a data-only change.
- **Seeds** are `0 … 2^53−1` because JSON numbers must survive JavaScript; the sidecar draws random seeds itself in that range and always passes an explicit seed upstream. Same seed + parameters → byte-identical WAV on CUDA (verified).
- **Reference clips:** uploads are normalized to float32 WAV (soundfile reads WAV/FLAC/OGG/Opus/MP3; the bundled ffmpeg handles the rest) and encoded once into a latent cached per clip, keyed by codec revision, device, precision and preprocessing; generations pass these as `ref_latents` (upstream's `--ref-latents` path). The encoder mirrors upstream's waveform path (soundfile decode, single-clip trim to the checkpoint's `max_ref_seconds`): with the same seed, a stereo 44.1 kHz clip gave bit-identical audio through upstream's `ref_wavs` and through the cached latent (RTX 5090), so results match the Space's waveform path. Encoding ≈ 0.19 s once, then nothing.
- **Sidecar preferences** (watermark, history limits) live in the SQLite `preferences` table and apply immediately — also to the external API, which never passes through the UI. Restart-level settings (locale, data root, device) stay in Rust's settings.json (D16).
- **Storage:** `<data-root>/irodori-studio.db` (WAL, migrations tracked by `PRAGMA user_version`); history audio in `history/<history_id>/<audio_id>.wav` (48 kHz mono PCM16); clips in `clips/<clip_id>/` with `audio.wav` and `latents/`. History keeps the request as submitted plus every resolved parameter; pruning (500 entries / 5 GB, D23) runs after each generation and when the limits change.
- **Emoji palette:** parsed from upstream's source with `ast` (gradio is not installed); `key` = the code points (`u1f442`, `u1f62e_200d_1f4a8`) as the stable i18n id; labels stay upstream's Japanese source text.
- **Text limits:** 2000 characters of text and 1000 of caption, as sanity bounds (the model itself truncates at `max_text_len` tokens and ~30 s of audio).
- **Setup step 7** (test generation, requirements §6.2) was a card on the ready screen; Session 3's Quick screen replaced it.

### S2 — Measurements (Windows 11, RTX 5090, driver 610.88, fp32, 40 steps)
- Cold model load 20.5 s; ≈ 5.3 GB VRAM in use afterwards.
- About 4 s of audio: predict_duration 30–150 ms, sample_rf 610–830 ms, decode_latent 22–55 ms, watermark 9–48 ms — 0.7–1.1 s per request end to end; 4 candidates ≈ 1.0 s.

### S3 — Quick screen and the parameter panel
- **Space parity** was checked against the Space's `app.py`: text + emoji palette, caption, reorderable multi-clip reference, the Sampling group (steps, candidates, seed, seconds, duration scale, schedule, sway, CFG mode and scales) and the Advanced group (CFG override, CFG min/max t, context KV cache, speaker K/V scale, max text/caption length, truncation, rescale k/sigma), a candidates grid and a run log. The Space fixes the runtime (bf16 on CUDA for model and codec, no load/unload control) and hard-codes reference normalization, decode mode and tail trimming; the app exposes those too (upstream CLI parity).
- **Parameter panel:** rendered only from `GET /models/active/capabilities` — groups in the order Sampling, Duration, CFG, Speaker, Reference, Advanced; `tier: "simple"` parameters (candidates, seed) sit in the main form; `visible_when` hides dependent controls (Sway coefficient, speaker/reference controls without a reference, tail settings without trimming). Blank means null for nullable numbers (placeholder = the localized meaning, e.g. "random", "auto", "off"). The request carries only values that differ from the schema default; history stores every resolved value.
- **Runtime group** is read-only (from `/health` → `engine.runtime`): changing device or precision reloads the model and belongs to Settings (Session 9, D9).
- **Style presets** (requirements §6.3 "感情・スタイルのプリセット") are ten caption templates in `src/features/quick/stylePresets.ts`: Japanese model input, localized button labels; they describe manner and mood rather than timbre, so they also suit reference audio (model card, "Conditioning Conflicts"). The Space has none.
- **Setup step 7** (test generation): the Quick screen opens with a sample sentence, so the first thing after setup is one click on Generate; the Session 2 card is gone.
- **Adopt / save:** adopting marks one candidate of a history entry (`PATCH /history/{id}`), for later reuse by the library and projects. Saving copies the WAV through the sidecar to a path from the native save dialog (`POST /audio/{id}/save`), since the WebView has no file system access; formats and post-processing arrive with `POST /export` (Session 7).
- **Emoji palette:** labels and descriptions are translated per code-point key in `emoji.json` (from the model card's `EMOJI_ANNOTATIONS.md`); an emoji a newer upstream adds falls back to upstream's Japanese text.
- A fresh result plays its first candidate once (`play()`, not the `autoplay` attribute, so revisiting the screen does not replay it). Generation keeps running and updating while the user is on another screen.
- **Save formats (ahead of Session 7):** "保存…" writes WAV, MP3, M4A (AAC), FLAC or Opus at 48 kHz (`POST /audio/{id}/save` with `format`; the Quick screen has a format selector). Everything but WAV is encoded by ffmpeg — plain conversion only; sample rate, loudness, tempo and gain remain Session 7's `POST /export` (D20).
- **ffmpeg in development:** installed builds use only the bundled LGPL ffmpeg (D20, staged in Session 10); dev runs fall back to an `ffmpeg` on PATH, so M4A/WebM reference clips and compressed saves work before staging. Without ffmpeg the UI offers only WAV, and uploads of other formats fail with `clip_format_unsupported` (MP3, OGG/Opus, FLAC and WAV are decoded by soundfile and need no ffmpeg).

