# CLAUDE.md

Operating context for Claude Code working in this repository. Read this first, then the documents under `docs/`.

## What this project is

`irodori-studio` (working name) is a **cross-platform (Windows + macOS Apple Silicon) Tauri 2 desktop app** for the Japanese TTS model **Irodori-TTS** (Aratako, MIT). It reaches parity with the official Hugging Face demo Space and the related community apps, and adds production tools: voice library, long-form narration, multi-speaker scripts, and an OpenAI/VOICEVOX-compatible local API. Distributed free via GitHub Releases.

Architecture in one line: **Next.js (WebView) → Tauri (Rust, process manager) → Python sidecar (FastAPI + uvicorn) → adapter → upstream `irodori_tts` (git submodule, pinned)**.

It follows the architecture of the owner's earlier app `C:\Dev\qwen-tts-desktop` (Windows-only, Qwen3-TTS). Reuse its proven patterns (bootstrap, sidecar lifecycle, teardown guard, layout detection, release staging) — but note the differences: this app is cross-platform, allows an explicit CPU mode, is multilingual, and is publicly distributed.

## Golden rules (do not violate)

1. **Never edit `third_party/Irodori-TTS`.** It is a pinned submodule. Only `sidecar/app/engine/irodori_adapter.py` may import `irodori_tts`. If upstream lacks something, raise it. (D3)
2. **Never pin `torch`.** It is installed per platform at first run (Windows cu128 / Windows CPU / macOS PyPI-MPS). (D2)
3. **Never hardcode the sidecar port.** Rust picks it; the frontend gets it via `get_sidecar_port`. (D10)
4. **Always kill the sidecar on exit**, including forced quit. No orphan Python processes.
5. **No browser storage** for app state. Settings via Tauri/Rust; data via the sidecar (SQLite + files). (D11, D16)
6. **Every visible UI string goes through i18n** (`ja` source; `en`, `zh-Hans`, `de` added in the same change). Sidecar and Rust return error **codes**, never user-facing prose. (D17)
7. **Parameters are driven by the capability schema** (`sidecar/models.json` + `sidecar/app/engine/params.py`). Never hardcode model names or parameter lists in UI components. This is what makes the future Large model a data-only change. (D5, D26)
8. **One resident model, one synthesis queue** shared by the UI and the external API. (D4, D24)
9. **Watermark decision lives only in `watermark_policy()`**; default ON. (D12)
10. **Reference-audio voices require recorded consent**; first run requires accepting the terms incl. upstream's ethical restrictions. (D13)
11. **UTF-8 everywhere**; cross-platform paths only; platform-specific code only in `platform/` modules or guarded branches.

## Tech stack

| Layer | Choice |
| --- | --- |
| Desktop shell | Tauri 2 (Rust) |
| Frontend | Next.js (static export) + TypeScript + Tailwind CSS |
| Client state | Zustand |
| i18n | react-i18next (`ja`, `en`, `zh-Hans`, `de`) |
| Waveform | wavesurfer.js (+ regions) |
| Sidecar | Python (upstream's version), FastAPI + uvicorn, uv-managed |
| Inference | upstream `irodori_tts` (`InferenceRuntime`) via `TorchBackend`; devices `cuda` / `mps` / `cpu`; MLX slot reserved |
| Model | `Aratako/Irodori-TTS-v4.1-Small` + `Aratako/Semantic-DACVAE-Japanese-32dim` |
| Storage | settings.json (Rust) + SQLite + files (sidecar) |
| Audio | wav native (48 kHz); other formats + loudness/tempo via bundled LGPL ffmpeg |
| Transport | internal HTTP + SSE on `127.0.0.1:<random>`; optional external API (default `127.0.0.1:50221`) |
| Distribution | GitHub Releases: Windows NSIS, macOS arm64 dmg (ad-hoc signed, not notarized) |

## Language policy

- **Japanese**: `docs/requirements.md` only (canonical spec for the owner).
- **English**: everything else — this file, code, comments, identifiers, other docs.
- **In-app UI**: localized via i18n; `ja` is the source locale. English words in code/docs are identifiers, never app copy.

## Documents

| File | Purpose |
| --- | --- |
| `docs/requirements.md` | canonical requirements (Japanese); §11 lists items awaiting owner confirmation |
| `docs/decisions.md` | decision records with `LOCKED` / `CONFIRM` / `OPEN` status |
| `docs/architecture.md` | components, engine layer, registry, bootstrap, storage, data flows |
| `docs/api-spec.md` | internal + external (OpenAI / VOICEVOX) API contract |
| `docs/upstream-notes.md` | upstream facts: runtime API, full parameter table with Space defaults, limits, measurements, MPS notes, parity checklist |
| `docs/project-structure.md` | target tree |
| `docs/session-plan.md` | build sequence with acceptance criteria |
| `docs/coding-conventions.md` | conventions and contract-sync rules |

## Common commands

> Verified on Windows. `npm run tauri build` needs `resources/` staged first (Session 10); the macOS stage script is untested without a Mac.

```bash
# Submodule
git submodule update --init --recursive

# Frontend (repo root)
npm install
npm run dev
npm run build                 # static export for Tauri
node scripts/check-i18n.mjs   # missing/unused translation keys

# Tauri (repo root)
npm run tauri dev
npm run tauri icon assets/icon.png

# Installers: stage resources/ (sidecar + irodori_tts, uv, LGPL ffmpeg), then build
powershell -ExecutionPolicy Bypass -File scripts\stage-runtime.ps1   # Windows
scripts/stage-runtime.sh                                             # macOS
npm run tauri build           # then gen-licenses + check-staged run before bundling

# Sidecar (from sidecar/, uv-managed; NO torch here — first-run setup installs it)
uv sync
uv run ruff check .
uv run pytest -m "not gpu"
# GPU smoke test: a torch venv + a provisioned data root (docs/coding-conventions.md)
IRODORI_TEST_DATA_ROOT=<data-root> <runtime-venv-python> -m pytest -m gpu tests/test_gpu_smoke.py

# Lint
npm run lint
cargo clippy --manifest-path src-tauri/Cargo.toml
```

## How to work here

- Follow `docs/session-plan.md` session by session; its Global rules apply throughout.
- Keep `api-spec.md`, `src/lib/types.ts`, and `sidecar/app/schemas.py` in sync in the same change.
- Do not re-litigate `LOCKED` decisions. `CONFIRM` items are implemented with the stated default but built so the override is cheap. When you resolve an `OPEN` item, record it in `decisions.md` → "Resolved during implementation".
- Items in `requirements.md` §11 are pending owner confirmation — implement the provisional default and do not block on them.
- Verify facts in `upstream-notes.md` marked "(verify)" against the pinned submodule before depending on them.
- Keep changes scoped to the current session. Prefer small, reviewable commits.
