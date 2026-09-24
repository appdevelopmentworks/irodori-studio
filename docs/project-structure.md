# Project structure

Target tree. Create directories when the session that needs them starts (Session 0 creates the skeleton with stubs only).

```
irodori-studio/
├─ CLAUDE.md                      Claude Code operating context
├─ AGENTS.md                      Codex operating context (same rules)
├─ README.md                      user-facing install + first-launch approval steps
├─ LICENSE                        MIT (D25, confirm)
├─ THIRD_PARTY_NOTICES.md         upstream, ffmpeg (LGPL), uv, SilentCipher, analyzer, fonts
├─ assets/
│  ├─ icon.png                    app icon SOURCE (1024×1024, transparent, no wordmark) → `tauri icon`
│  ├─ icon-with-text.png          alternative with the "Irodori-TTS" wordmark (not used by default)
│  └─ icon.jpg                    original artwork (2048×2048, framed mockup) — keep as the master
├─ docs/                          specs (.md only)
├─ .github/workflows/
│  ├─ ci.yml                      lint + typecheck + i18n missing-key check + sidecar unit tests
│  └─ release.yml                 Windows NSIS + macOS arm64 dmg (ad-hoc signed)
├─ scripts/
│  ├─ stage-runtime.ps1           stage uv.exe + ffmpeg.exe + sidecar + irodori_tts into resources (Windows)
│  ├─ stage-runtime.sh            same for macOS arm64
│  └─ check-i18n.mjs              fails on missing/unused keys
├─ third_party/
│  └─ Irodori-TTS/                git submodule, pinned commit, NEVER edited (D3)
├─ resources/                     staged at build time (gitignored contents)
│  ├─ uv/                         uv binary per platform
│  ├─ ffmpeg/                     LGPL ffmpeg per platform
│  └─ sidecar/                    copied sidecar + irodori_tts package
├─ src/                           Next.js (App Router, static export)
│  ├─ app/
│  │  ├─ layout.tsx
│  │  └─ page.tsx                 app shell: sidebar nav + active screen
│  ├─ features/
│  │  ├─ setup/                   first-run wizard (language, terms, probe, data root, install, download, smoke test)
│  │  ├─ quick/                   QuickScreen + sections (text, voice, caption, generate, run log), request building,
│  │  │                           generation (job stream), style presets, LoRA picker, library voice picker
│  │  ├─ params/                  capability-driven ParamPanel / ParamField (schema helpers, texts, read-only Runtime group)
│  │  ├─ voice-studio/            VoiceStudioScreen: VoiceList (library, new-voice buttons, package import), NewDesignVoice,
│  │  │                           NewClipVoice (files / recording), NewEmbeddingVoice, VoiceEditor (reference, consent,
│  │  │                           export, delete), VoiceDefaults (+ audition), ClipList, ClipEditor (wavesurfer regions),
│  │  │                           Recorder + mic.ts (AudioWorklet), ConsentBox, EncodeBadge, jobs.ts, clipOps.ts
│  │  ├─ narration/               editor, reading preview, chunk list, render, assemble
│  │  ├─ script/                  table editor, parser, speaker map, takes, export
│  │  ├─ library/                 history, presets, projects
│  │  ├─ api-server/              config, status, request log
│  │  └─ settings/                language, paths, model mgmt, device/precision, watermark, output defaults, logs, licenses
│  ├─ components/                 AppRoot (boot + routing by status), Startup/Error screens, AppShell (Sidebar + screen + StatusBar),
│  │                              ComingSoon, ErrorNotice, LanguageSwitcher, EmojiPalette, CandidateGrid;
│  │                              later WaveformEditor, JobProgress, QueueBadge, UpdateBanner …
│  ├─ i18n/
│  │  ├─ index.ts                 react-i18next init (bundled resources, sync); locale from settings
│  │  ├─ config.ts                supported locales; source locale `ja`
│  │  ├─ resources.ts             registers every locales/<locale>/<feature>.json
│  │  ├─ I18nProvider.tsx         provider; syncs <html lang>, document and window title
│  │  ├─ i18next.d.ts             typed keys (checked against `ja`)
│  │  └─ locales/{ja,en,zh-Hans,de}/*.json   one file per feature; file name = first key segment
│  ├─ lib/
│  │  ├─ api.ts                   ALL internal-API calls
│  │  ├─ sse.ts                   job streams
│  │  ├─ tauri.ts                 typed invoke wrappers
│  │  ├─ types.ts                 mirrors api-spec.md (+ Tauri IPC types)
│  │  ├─ errors.ts                error code → i18n key
│  │  ├─ jobs.ts                  client job state advanced by SSE events (shared by screens)
│  │  ├─ wav.ts                   WAV writer for recordings
│  │  └─ format.ts                Intl formatting (bytes, memory, seconds, dates, percent)
│  └─ store/                      zustand: app, nav, sidecar, quick, voices; later narration, script
├─ src-tauri/
│  ├─ tauri.conf.json             bundle targets, resources, macOS signingIdentity "-", entitlements, localized plist strings
│  ├─ Info.plist                  merged into the macOS Info.plist (NSMicrophoneUsageDescription)
│  ├─ Entitlements.plist          com.apple.security.device.audio-input (hardened runtime)
│  ├─ macos/<locale>.lproj/InfoPlist.strings   localized macOS permission prompt
│  ├─ icons/                      generated
│  └─ src/
│     ├─ main.rs / lib.rs
│     ├─ layout.rs                dev vs installed paths
│     ├─ paths.rs
│     ├─ config.rs                settings.json
│     ├─ error.rs                 error codes returned to the frontend (D17)
│     ├─ platform/{mod.rs, policy.rs, windows.rs, macos.rs}   probe, device policy, process trees, free space
│     ├─ bootstrap.rs             idempotent first-run steps + progress events
│     ├─ sidecar.rs               port, spawn, health, teardown guard
│     ├─ update_check.rs          GitHub Releases latest
│     └─ commands.rs
└─ sidecar/
   ├─ pyproject.toml              NO torch (D2); upstream non-torch deps pinned
   ├─ .python-version, uv.lock    3.10 (upstream); the lock contains no torch family
   ├─ models.json                 model registry (D5) + shared assets (SilentCipher)
   ├─ upstream.json               pinned upstream commit + torch install recipe (D2/D3)
   ├─ app/
   │  ├─ main.py                  starts internal (+ optional external) uvicorn
   │  ├─ config.py                runtime config from env set by Rust
   │  ├─ lifecycle.py             UTF-8, exit with the parent app
   │  ├─ assets.py                where downloaded model files live
   │  ├─ provision/               run by the Rust bootstrap: download.py (resumable), selfcheck.py, events.py
   │  ├─ schemas.py               pydantic, mirrors api-spec.md
   │  ├─ errors.py                stable error codes
   │  ├─ routers/                 system, models (+ /emoji), tts, jobs (+ SSE, /queue), audio, clips, history, preferences, deps;
   │  │                           voices; later text, narration, script, export, presets, projects, api_server
   │  ├─ compat/                  openai.py, voicevox.py (external API)
   │  ├─ engine/
   │  │  ├─ base.py               TtsBackend protocol (D6)
   │  │  ├─ registry.py           models.json loader + capabilities
   │  │  ├─ params.py             single parameter table (D26)
   │  │  ├─ irodori_adapter.py    TorchBackend → upstream InferenceRuntime (ONLY upstream import site)
   │  │  └─ host.py               resident EngineHost singleton
   │  ├─ services/                container (wiring), job_manager (events), queue (single FIFO), synthesis, policy (watermark),
   │  │                           clips, voices (library, encode jobs, packages), history, preferences, system_info;
   │  │                           later narration, script, presets, projects
   │  ├─ text/                    dictionary.py, reading.py, chunker.py, srt.py, script_parser.py
   │  ├─ audio/                   io.py (upload decode, WAV reading/writing), export.py (ffmpeg save formats);
   │  │                           later concat.py, post.py (loudnorm/atempo/gain)
   │  └─ storage/                 db.py (SQLite + migrations), files.py (data-root layout, ULIDs)
   └─ tests/                      unit tests that do not need torch (fake backend in conftest.py: params, registry, policy, API, jobs)
                                  + test_gpu_smoke.py (marker `gpu`, real model; see coding-conventions.md)
```
