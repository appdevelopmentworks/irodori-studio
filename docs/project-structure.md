# Project structure

Target tree. Create directories when the session that needs them starts (Session 0 creates the skeleton with stubs only).

```
irodori-studio/
├─ CLAUDE.md                      Claude Code operating context
├─ AGENTS.md                      Codex operating context (same rules)
├─ README.md, README.ja.md        user-facing install + first-launch approval steps (en / ja)
├─ LICENSE                        MIT (D25, confirm)
├─ THIRD_PARTY_NOTICES.md         models, upstream, SilentCipher, analyzer, runtime, frontend + Rust summaries,
│                                 uv, ffmpeg (LGPL); bundled into installers
├─ assets/
│  ├─ icon.png                    app icon SOURCE (1024×1024, transparent, no wordmark) → `tauri icon`
│  ├─ icon-with-text.png          alternative with the "Irodori-TTS" wordmark (not used by default)
│  └─ icon.jpg                    original artwork (2048×2048, framed mockup) — keep as the master
├─ docs/                          specs (.md only)
├─ .github/workflows/
│  ├─ ci.yml                      lint + typecheck + i18n missing-key check + sidecar unit tests
│  ├─ release.yml                 Windows NSIS + macOS arm64 dmg (ad-hoc signed) → artifacts, draft release on v* tags
│  └─ ffmpeg.yml                  by hand: audio-only ffmpeg for both platforms + its sources → a prerelease
├─ scripts/
│  ├─ stage-runtime.ps1           stage uv.exe + ffmpeg.exe + sidecar + irodori_tts into resources (Windows)
│  ├─ stage-runtime.sh            same for macOS arm64
│  ├─ build-ffmpeg.sh             the audio-only LGPL ffmpeg (FFmpeg + LAME + Opus, static; macOS / MSYS2 UCRT64)
│  ├─ gen-licenses.mjs            before bundling: resources/licenses/rust-crates.md from cargo metadata
│  ├─ check-staged.mjs            before bundling: refuses an unstaged resources/
│  └─ check-i18n.mjs              fails on missing/unused keys
├─ third_party/
│  └─ Irodori-TTS/                git submodule, pinned commit, NEVER edited (D3)
├─ .stage/                        downloads and builds of the stage scripts (gitignored)
├─ resources/                     staged at build time (gitignored contents); bundled as the resource folder
│  ├─ uv/                         uv binary per platform
│  ├─ ffmpeg/                     audio-only LGPL ffmpeg per platform + LICENSE*.txt (FFmpeg, LAME, Opus) + BUILD.txt
│  ├─ sidecar/                    copied sidecar + irodori_tts package (with its LICENSE)
│  └─ licenses/                   rust-crates.md, generated per build
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
│  │  ├─ narration/               NarrationScreen: ManuscriptSection (paste / file, format, rules), SettingsSection
│  │  │                           (voice + lock, caption, parameters, pauses, dictionary), ChunkSection (render / resume,
│  │  │                           takes, edit, readings), ExportSection (join, export + subtitles), actions.ts
│  │  ├─ dictionary/              DictionaryEditor (the user dictionary, D19)
│  │  ├─ script/                  ScriptScreen: ImportSection (paste / .txt / .csv / .tsv, append / replace),
│  │  │                           SpeakersSection (speaker → voice, caption), SettingsSection (title, pause, naming
│  │  │                           template + preview, subtitles, parameters, dictionary), LinesSection + LineRow (table
│  │  │                           editor, emoji at the caret, render / redo, takes, shared player), ExportSection (join,
│  │  │                           per-line / merged / subtitles into a folder, CSV / TSV), actions.ts
│  │  ├─ library/                 LibraryScreen: HistoryPanel (filters, selection, export, delete) + HistoryRow
│  │  │                           (play, adopt, again, reuse, save, details), LimitsPanel, PresetsPanel, actions.ts
│  │  ├─ output/                  OutputSettings (shared export settings) + output.ts
│  │  ├─ projects/                ProjectBar (save / open `.iroproj`)
│  │  ├─ api-server/              ApiServerScreen: ConfigSection (enable, bind, port, API key), StatusSection (URLs),
│  │  │                           UsageSection (OpenAI SDK example, VOICEVOX URL, style ids), RequestLog, snippets.ts
│  │  └─ settings/                SettingsScreen (tabs): GeneralTab (language, updates, API server, shortcuts), StorageTab
│  │                              (folders, move + result), EngineTab (model, device / precision, monitor, repair),
│  │                              OutputTab (watermark, export defaults, limits), LogsTab, AboutTab (licenses, terms),
│  │                              Section, components.ts (licenses of models and main components)
│  ├─ components/                 AppRoot (boot + routing by status), Startup/Error/Move screens, AppShell (Sidebar + screen +
│  │                              StatusBar, shortcuts), UpdateBanner, EngineBanner, ErrorNotice, LanguageSwitcher,
│  │                              EmojiPalette, CandidateGrid, ProgressBar, usePlayer (one shared audio player), CopyButton,
│  │                              LogViewer, TermsText
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
│  │  ├─ textFile.ts              text files the user picks (UTF-8, else Shift_JIS)
│  │  ├─ clipboard.ts             copy to the clipboard
│  │  └─ format.ts                Intl formatting (bytes, memory, seconds, dates, percent)
│  └─ store/                      zustand: app, nav, sidecar, quick, voices, narration, script, library, presets, projects,
│                                 apiServer, settings
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
│     ├─ platform/{mod.rs, policy.rs, windows.rs, macos.rs}   probe, device policy, process trees, free space,
│     │                           opening folders / links, HTTP via the system curl, junctions
│     ├─ bootstrap.rs             idempotent first-run steps + progress events, repair
│     ├─ sidecar.rs               port, spawn, health, teardown guard
│     ├─ update_check.rs          GitHub Releases latest (D15)
│     ├─ relocate.rs              moving the data root (D16)
│     ├─ logs.rs                  log tails for Settings and the error screen
│     └─ commands.rs              commands, app state, startup / setup / move flows, runtime override
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
   │  │                           voices, text (dictionary, reading), narration, script, presets, projects, api_server
   │  ├─ compat/                  external API: server.py (app, API key, request log), openai.py, voicevox.py,
   │  │                           speech.py (voices, speed, chunking, queue, encoding), styles.py, assets/icon.png
   │  ├─ engine/
   │  │  ├─ base.py               TtsBackend protocol (D6)
   │  │  ├─ registry.py           models.json loader + capabilities
   │  │  ├─ params.py             single parameter table (D26)
   │  │  ├─ irodori_adapter.py    TorchBackend → upstream InferenceRuntime (ONLY upstream import site)
   │  │  └─ host.py               resident EngineHost singleton
   │  ├─ services/                container (wiring), job_manager (events), queue (single FIFO), synthesis, policy (watermark),
   │  │                           clips, voices (library, encode jobs, packages), takes (chunk / line audio rows),
   │  │                           narration (split, render jobs, assemble, export), script (lines, speaker map, render
   │  │                           jobs, assemble, export, tables), history, library (regenerate, export), presets,
   │  │                           projects (.iroproj), preferences, system_info (+ memory, cache), licenses, api_server
   │  │                           (the external listener)
   │  ├─ text/                    dictionary.py (user dictionary), reading.py (pyopenjtalk-plus readings, length
   │  │                           estimates), chunker.py (D18, Markdown to text), srt.py (SRT/WebVTT in and out),
   │  │                           script_parser.py ("話者：セリフ" text, CSV / TSV in and out), naming.py (file-name templates)
   │  ├─ audio/                   io.py (upload decode, WAV reading/writing), export.py (formats, many files at once),
   │  │                           post.py (sample rate, two-pass loudnorm, atempo, gain), assemble.py (silence trim,
   │  │                           joining takes)
   │  └─ storage/                 db.py (SQLite + migrations), files.py (data-root layout, ULIDs)
   └─ tests/                      unit tests that do not need torch (fake backend in conftest.py: params, registry, policy, API, jobs)
                                  + test_gpu_smoke.py (marker `gpu`, real model; see coding-conventions.md)
```
