# Session plan

Build sequence for Claude Code / Codex. Each session is a demoable increment with explicit acceptance criteria. Work top to bottom; do not start a session until the previous one's acceptance criteria pass. Before each session read `requirements.md`, `decisions.md`, `architecture.md`, `api-spec.md`, and the relevant part of `upstream-notes.md`.

## Global rules (apply to every session)

- **Every visible UI string goes through i18n (`t()`), with `ja` as the source locale.** Add keys to all four locales (`ja`, `en`, `zh-Hans`, `de`) in the same change; `scripts/check-i18n.mjs` must pass. Code, identifiers, and docs are English.
- The frontend never hardcodes a port/URL; it uses `get_sidecar_port`.
- Keep `api-spec.md`, `src/lib/types.ts`, and `sidecar/app/schemas.py` in sync.
- Never edit `third_party/Irodori-TTS`. Only `sidecar/app/engine/irodori_adapter.py` imports `irodori_tts` (D3).
- Never pin torch (D2). Before Session 1's torch step, `import irodori_tts` will fail — expected.
- Parameters come from the capability schema (`engine/params.py` + `models.json`); never hardcode a parameter list in UI components (D5, D26).
- When an `OPEN` item in `decisions.md` is resolved, record the outcome under "Resolved during implementation" in the same change.
- Test on Windows each session. Mac verification points are marked **[mac]**; if no Mac is available, record them as pending (requirements §11 #21).

---

## Session 0 — Scaffolding + upstream pin

**Goal:** runnable empty shell with the agreed structure, i18n wired, upstream pinned.

**Tasks**
- `git init`; `.gitignore` (node_modules, `src-tauri/target`, `.venv`, `resources/*` staged contents, caches, logs, `out/`, `.next/`).
- `git submodule add https://github.com/Aratako/Irodori-TTS third_party/Irodori-TTS`; check out the latest `main` commit and record the sha in `decisions.md` (Resolved) and `upstream-notes.md`.
- Resolve D3 sub-item: read upstream `pyproject.toml` / `.python-version`; write `sidecar/pyproject.toml` with upstream's **non-torch** runtime deps pinned + FastAPI + uvicorn + python-multipart + huggingface_hub + soundfile. Use upstream's Python version.
- Next.js (TypeScript strict, App Router, Tailwind, `output: 'export'`), Tauri 2 single window. Window title and placeholder text via i18n.
- `react-i18next` with `ja/en/zh-Hans/de` locale files and a language switcher stub; `scripts/check-i18n.mjs`.
- Icons from `assets/icon.png` via `npm run tauri icon assets/icon.png` (if the icon is not provided yet, use a placeholder and note it).
- Directory skeleton from `project-structure.md` (stubs only).
- Lint config: ESLint + tsc, clippy + fmt, ruff. `ci.yml` running lint + i18n check.

**Acceptance**
- `npm run tauri dev` opens a window; switching language changes the placeholder text in all four locales.
- `uv sync` (or `uv pip install -e .`) for the sidecar succeeds without torch.
- Submodule present at a pinned sha; lint and i18n check pass.

---

## Session 1 — Platform probe, first-run bootstrap, sidecar lifecycle (highest risk)

**Goal:** from a clean machine, the wizard sets up the environment for Windows CUDA, Windows CPU, and macOS MPS, downloads the model, and the sidecar reaches ready.

**Tasks**
- `platform/windows.rs` (nvidia-smi: name, compute_cap, VRAM) and `platform/macos.rs` (chip, macOS version, memory). Map to device + precision per D7–D9; resolve D2 sub-item (cu128 minimum compute capability).
- `layout.rs`, `paths.rs`, `config.rs` (settings.json incl. locale, data root, terms accepted).
- `bootstrap.rs`: uv python install → venv at `<data-root>/runtime/venv` → base deps → torch (platform index) → model/codec/tokenizer/SilentCipher download into `HF_HOME` with resume → marker file. Idempotent; progress events; retry; logs.
- `sidecar.rs`: free port, spawn, `/health` polling, status enum, teardown guard (Windows Job Object, macOS process group).
- Minimal sidecar: `/health`, `/system`.
- Frontend setup wizard (language → terms incl. ethical restrictions → probe result → data root → install → download → done). All copy via i18n.

**Acceptance**
- Windows + RTX 50: cu128 selected; `import irodori_tts` works in the venv; `/system` reports CUDA.
- Windows without NVIDIA (or forced CPU): explicit CPU-mode notice; setup completes.
- **[mac]** M2: MPS selected; setup completes. M1 shows the unsupported warning.
- Interrupting the model download and relaunching resumes it.
- Closing / force-quitting leaves no Python process. Second launch skips setup.

---

## Session 2 — Engine adapter, registry, core generation API

**Goal:** generate audio end-to-end via the internal API with capabilities, jobs, queue, history.

**Tasks**
- `engine/base.py` (TtsBackend), `engine/registry.py` + `models.json` (v4.1-Small with pinned HF revisions), `engine/params.py` (full table from `upstream-notes.md`, Space defaults).
- `engine/irodori_adapter.py` (TorchBackend): RuntimeKey/InferenceRuntime/SamplingRequest mapping; reference clips, cached latents, speaker embedding, LoRA adapter; timings via log parsing or runtime API.
- Resolve D12 sub-item (how to skip the watermark) and D27 (progress/cancel hooks). Implement `services/policy.py::watermark_policy`.
- `engine/host.py` resident model; load at startup after setup (D4).
- `services/job_manager.py`, `services/queue.py` (single FIFO, D24), `storage/db.py` (SQLite + migrations), `services/history.py`.
- Routers: system, models (incl. `/models/active/capabilities`, `/emoji`), tts, jobs (SSE), audio, history (basic).
- Error codes in `errors.py`.
- Unit tests that don't need torch (params schema, policy, registry); a GPU-marked smoke test.

**Acceptance**
- `POST /tts/generate` with (a) no reference, (b) caption only, (c) reference clips, (d) reference + caption, (e) 4 candidates → wav(s); SSE shows queued → started → candidate × N → completed with used seed + timings.
- Same seed + same params reproduce the same audio.
- Watermark toggle changes whether the watermark stage runs (visible in timings/logs).
- Cancel of a queued job works; running-job cancel behaves per D27 outcome.

---

## Session 3 — Frontend core: Quick screen + capability-driven parameter panel

**Goal:** full HF Space parity from the UI.

**Tasks**
- `lib/api.ts`, `lib/sse.ts`, `lib/tauri.ts`, `lib/types.ts`, `lib/errors.ts`; stores.
- App shell with sidebar navigation for all seven screens (placeholders for later ones).
- `ParamPanel` rendered from the capabilities schema: simple tier (text, emoji palette, voice/none/caption, style presets) + advanced tier (every parameter, grouped: Sampling / CFG / Speaker / Duration / Advanced / Runtime).
- `EmojiPalette` from `/emoji` with localized meanings; inserts at cursor.
- `CandidateGrid` + `AudioPlayer`; adopt / save a candidate; run log panel with seed and timings.
- Status bar: device, model, queue, CPU-mode notice.

**Acceptance**
- Every Space control is reachable and changes the request (verify by inspecting the stored history request).
- Language switch re-renders all labels including parameter help text.
- Cold start → generate → play without touching ports.

---

## Session 4 — Voice Studio + voice library

**Tasks**
- Design by caption → candidates → save as voice.
- Import clips (multi, reorder), microphone recording with guide sentences (**[mac]** mic permission), waveform trim/split (`wavesurfer.js` regions), consent confirmation (D13), speaker embedding import, LoRA association, defaults (caption/params/seed), test phrase.
- Latent encode on save + cache per model id.
- `.irovoice` export/import (D22).

**Acceptance**
- Each voice source (a–d in requirements §6.5) produces a usable voice.
- Imported/recorded voices cannot be saved without consent; consent is exported and re-imported.
- Second generation with a saved reference voice skips reference encoding (timings show it).

---

## Session 5 — Narration

**Tasks**
- `text/chunker.py` (D18), `text/dictionary.py`, `text/reading.py` (resolve D19 library), `text/srt.py` (parse + write SRT/VTT).
- Narration editor: paste / .txt / .md / .srt import, dictionary editor, reading preview, chunk list with estimated durations.
- Render job: sequential chunks, voice lock for caption-only voices, pauses, per-chunk regenerate/candidates, resume after cancel.
- Assemble → export with subtitles.

**Acceptance**
- A 5+ minute manuscript renders to one consistent-voice file + SRT whose timings match the audio (±100 ms per cue).
- No chunk exceeds the output limit; dictionary entries change pronunciation.
- SRT input mode fits each line to its cue duration.

---

## Session 6 — Script (dialogue)

**Tasks**
- `text/script_parser.py` ("話者：セリフ" and "話者: セリフ"; CSV/TSV with header mapping).
- Table editor, speaker → voice mapping, per-line caption/emoji/candidates/seed/pause.
- Render job with per-line takes; adopt takes.
- Export: per-line files with naming template, merged drama audio, subtitles.

**Acceptance**
- A 20+ line, 3-speaker script exports both per-line files (correct names) and a merged file; CSV round-trips without loss.

---

## Session 7 — Output, post-processing, library, projects

**Tasks**
- `audio/export.py` + `audio/post.py` via bundled ffmpeg: formats, 44.1 kHz, loudnorm presets, atempo, gain (D20).
- Library screen: history search/filter, replay, regenerate, reuse params, re-export, delete; pruning settings (D23); presets.
- Projects `.iroproj` save/open for narration and script.

**Acceptance**
- All formats open in a standard player; loudness presets measure within ±1 LU of target.
- History pruning respects count and size limits. A saved project reopens with adopted takes intact.

---

## Session 8 — External API server

**Tasks**
- Second uvicorn listener controlled from the API Server screen (enable, bind, port, API key) (D21).
- `compat/openai.py` (mirror Irodori-TTS-Server request/response incl. `irodori` extension, `speed`, chunking, SSE chunks).
- `compat/voicevox.py` per `api-spec.md`; verify against the VOICEVOX Engine OpenAPI and document deviations.
- Shared queue with the UI; request log view.

**Acceptance**
- The OpenAI Python SDK example from `upstream-notes.md` sources works against the app.
- A VOICEVOX-API client (e.g. YMM4 configured with the app URL, or a scripted client) lists speakers and synthesizes.
- LAN bind refuses requests without the API key.

---

## Session 9 — Settings, update notice, polish

**Tasks**
- Settings: language, data root move (copy → verify → switch), model management, device/precision override (reload), watermark, output defaults, history limits, API server shortcut, update check toggle, log viewer, GPU/memory monitor, licenses + terms.
- `update_check.rs` + banner (D15).
- Error-state pass (no model, download failure, disk full, device lost), empty states, keyboard shortcuts, accessibility basics.
- Translation review pass for `en`, `zh-Hans`, `de`.

**Acceptance**
- All previous acceptance criteria still pass; no untranslated strings (check script + manual scan); data root move preserves voices/history.

---

## Session 10 — Packaging & release

**Tasks**
- `scripts/stage-runtime.ps1` / `.sh`: stage uv, LGPL ffmpeg, sidecar source, pinned `irodori_tts`.
- `release.yml`: Windows NSIS; macOS arm64 dmg with ad-hoc signing of app + bundled binaries (D14). Attach artifacts to a GitHub Release.
- README (ja + en): requirements, install, first-launch approval (`xattr -dr com.apple.quarantine ...`; SmartScreen), troubleshooting, ethical restrictions.
- `LICENSE`, `THIRD_PARTY_NOTICES.md` (verify licenses: upstream, codec, SilentCipher, ffmpeg build, uv, analyzer dictionary).
- Resolve D14 sub-item (quarantine on downloaded runtime files).

**Acceptance (test matrix)**
- Fresh Windows 11 + RTX 50; fresh Windows 11 without NVIDIA; **[mac]** fresh macOS 14+ on M2 (16 GB and 8 GB if available): install → wizard → quick generation → narration export → API call → uninstall leaves no running processes.

---

## After v1

From `requirements.md` §3.2: training (Whisper → manifest → Speaker Inversion / LoRA), Whisper-based misread detection, .docx/.pdf input, MLX backend, Gradio-compatible API, Large model entry when released.
