# AGENTS.md

Operating context for Codex (and other coding agents) working in this repository. The rules are identical to `CLAUDE.md`; if the two ever diverge, `CLAUDE.md` wins and this file must be updated to match. Read this first, then the documents under `docs/`.

## What this project is

`irodori-studio` (working name) is a **cross-platform (Windows + macOS Apple Silicon) Tauri 2 desktop app** for the Japanese TTS model **Irodori-TTS** (Aratako, MIT). It reaches parity with the official Hugging Face demo Space and the related community apps, and adds production tools: voice library, long-form narration, multi-speaker scripts, and an OpenAI/VOICEVOX-compatible local API. Distributed free via GitHub Releases.

Architecture in one line: **Next.js (WebView) → Tauri (Rust, process manager) → Python sidecar (FastAPI + uvicorn) → adapter → upstream `irodori_tts` (git submodule, pinned)**.

Reference implementation for shared patterns: `C:\Dev\qwen-tts-desktop` (Windows-only predecessor).

## Golden rules (do not violate)

1. **Never edit `third_party/Irodori-TTS`.** Only `sidecar/app/engine/irodori_adapter.py` may import `irodori_tts`. (D3)
2. **Never pin `torch`.** Installed per platform at first run. (D2)
3. **Never hardcode the sidecar port.** (D10)
4. **Always kill the sidecar on exit**, including forced quit.
5. **No browser storage** for app state. (D11, D16)
6. **Every visible UI string goes through i18n** (`ja` source; `en`, `zh-Hans`, `de` in the same change). Backends return error codes only. (D17)
7. **Parameters are driven by the capability schema**; never hardcode model names or parameter lists in UI. (D5, D26)
8. **One resident model, one synthesis queue** for UI and external API. (D4, D24)
9. **Watermark decision only in `watermark_policy()`**; default ON. (D12)
10. **Reference-audio voices require recorded consent**; first run requires accepting the terms. (D13)
11. **UTF-8 everywhere**; cross-platform paths; platform code only in `platform/` modules or guarded branches.

## Tech stack

See `CLAUDE.md` → Tech stack (identical).

## Language policy

- **Japanese**: `docs/requirements.md` only.
- **English**: everything else.
- **In-app UI**: localized via i18n; `ja` is the source locale.

## Documents

`docs/requirements.md` (canonical, Japanese; §11 = pending owner confirmation), `docs/decisions.md`, `docs/architecture.md`, `docs/api-spec.md`, `docs/upstream-notes.md`, `docs/project-structure.md`, `docs/session-plan.md`, `docs/coding-conventions.md`.

## Common commands

See `CLAUDE.md` → Common commands (identical).

## How to work here

- Follow `docs/session-plan.md` session by session.
- Keep `api-spec.md`, `src/lib/types.ts`, `sidecar/app/schemas.py` in sync in the same change.
- Do not re-litigate `LOCKED` decisions; implement `CONFIRM` defaults with cheap overrides; record resolved `OPEN` items in `decisions.md`.
- Do not block on `requirements.md` §11 items — use the provisional defaults.
- Keep changes scoped to the current session; small, reviewable commits.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
