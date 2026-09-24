# Coding conventions

Conventions for consistency across Claude Code / Codex sessions. Lightweight on purpose.

## General

- Match the style of the file you are editing. Small, reviewable changes scoped to the current session (`session-plan.md`).
- No secrets in the repo. The external API key is user-generated at runtime and stored in settings, never committed.
- Comments explain *why*, not *what*.
- Cross-platform by default: every path via platform APIs (`pathlib`, Tauri path APIs); no hardcoded `\` or `/`; no Windows-only or macOS-only code outside `platform/` modules and clearly guarded branches.

## TypeScript / Next.js

- Strict mode. No `any` without a justifying comment.
- App Router; function components with hooks.
- **All internal-API access goes through `src/lib/api.ts`**; SSE through `src/lib/sse.ts`; all `invoke()` through `src/lib/tauri.ts`. Contract types in `src/lib/types.ts` mirror `api-spec.md`.
- Base URL from the `sidecar` store (via `get_sidecar_port`). Never write a port literal.
- **i18n:** every visible string uses `t("namespace.key")`. Keys are English, dot-separated, grouped by feature. Add the key to `ja`, `en`, `zh-Hans`, `de` in the same change. No string concatenation for sentences — use interpolation. Numbers/dates via `Intl` with the active locale. Sidecar error `code` → `lib/errors.ts` → i18n key.
  - Locale files are `src/i18n/locales/<locale>/<feature>.json`; the file name is the key's first segment (`home.json` → `t('home.placeholder.title')`). Register a new file for all four locales in `src/i18n/resources.ts`.
  - Guards: `t()` keys are type-checked against `ja` (`tsc`); `scripts/check-i18n.mjs` checks locale parity, plural forms, `{{variables}}` and unused keys; ESLint `i18next/no-literal-string` rejects raw JSX text and literals in visible attributes (`placeholder`, `title`, `alt`, `aria-label`, …).
- **Parameters are data, not JSX.** The parameter panel renders from the capability schema; adding a parameter must not require touching UI components beyond an optional custom widget.
- State: small focused Zustand stores in `src/store/`.
- Styling: Tailwind. Extract a component before a class string becomes unreadable. Layout must survive the longest locale (German).
- No `localStorage` / `sessionStorage` / IndexedDB for app state (D11).
- `npm run lint` (ESLint + `tsc --noEmit`) and `node scripts/check-i18n.mjs` must pass.

## Rust / Tauri

- Edition 2021; `cargo clippy` clean; `cargo fmt`.
- `anyhow::Result` at boundaries, `thiserror` for typed errors the UI must distinguish. Tauri commands return `Result<T, String>` where the string is an **error code**, not prose (the frontend translates).
- One module per responsibility (`layout`, `paths`, `config`, `platform/*`, `bootstrap`, `sidecar`, `update_check`, `commands`).
- **Rust owns the sidecar process.** Spawn, health-check, guaranteed teardown (Job Object on Windows, process group on macOS, drop guard + exit handlers).
- Long-running bootstrap steps stream progress via Tauri events.
- Build command args as vectors; never interpolate user input into a shell string.

## Python / sidecar

- Python version = upstream's `.python-version`; managed by uv. `ruff` for lint/format.
- `uv.lock` never contains the torch family (enforced by `tests/test_dependency_policy.py`). In a venv where torch was installed with `uv pip install`, use `uv sync --inexact`; a plain `uv sync` removes torch again.
- Type hints on public functions; pydantic models for all bodies (`app/schemas.py`).
- **Only `app/engine/irodori_adapter.py` imports `irodori_tts`.** Everything else talks to `TtsBackend`. Never edit `third_party/Irodori-TTS` (D3).
- Routers thin (`app/routers/`, `app/compat/`); logic in `app/services/`, `app/text/`, `app/audio/`.
- One resident model (`engine/host.py`); one synthesis queue (`services/queue.py`); all generation paths — UI and external API — go through the queue.
- Watermark decision only in `services/policy.py::watermark_policy` (D12).
- Errors raise typed exceptions mapped to stable codes in `app/errors.py`; never return free-text-only errors.
- Force UTF-8 at startup. All storage locations from env/args set by Rust; no hardcoded user paths.
- ffmpeg path from `IRODORI_FFMPEG`; never assume ffmpeg on PATH in installed builds.
- Tests: pure-Python units (chunker, parsers, SRT, policy, registry, params schema, compat translation) must run without torch in CI; API and job tests use the fake backend in `tests/conftest.py`. GPU/MPS tests are marked `gpu` and run manually with a torch venv against a provisioned data root, e.g. the app's runtime venv plus pytest: `uv pip install --python <data-root>/runtime/venv/<Scripts|bin>/python pytest`, then from `sidecar/` run `IRODORI_TEST_DATA_ROOT=<data-root> <that python> -m pytest -m gpu tests/test_gpu_smoke.py` (`IRODORI_TEST_DEVICE` picks cuda / mps / cpu).

## Cross-cutting contract rule

`api-spec.md` is the single source of truth. These must always agree, updated in the same change:
1. `docs/api-spec.md`
2. `src/lib/types.ts`
3. `sidecar/app/schemas.py`

Likewise the parameter table: `docs/upstream-notes.md` (facts) → `sidecar/app/engine/params.py` (implementation) → capability schema (served) — the UI only consumes the served schema.

## Commits

- Conventional, present tense, scoped: `feat(sidecar): add narration chunker`, `fix(tauri): kill sidecar on forced quit`, `i18n(de): translate voice studio`.
- One logical change per commit where practical. Submodule bumps are their own commit: `chore(upstream): bump Irodori-TTS to <sha>`.
