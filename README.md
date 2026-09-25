# irodori-studio

An unofficial desktop app for the Japanese text-to-speech model [Irodori-TTS](https://github.com/Aratako/Irodori-TTS) by Aratako — for Windows (NVIDIA GPU, or CPU) and macOS (Apple Silicon).

[日本語版 README はこちら](README.ja.md)

> **Status:** v0.1.0, feature-complete and in pre-release testing. Installers will be published on the [Releases](https://github.com/appdevelopmentworks/irodori-studio/releases) page. Windows has been tested on Windows 11 with an RTX 50-series GPU; macOS builds have not yet been verified on real hardware.
>
> "irodori-studio" is a working name. This is **not** the official Irodori-TTS app.

## Features

- **Quick generation** — every parameter of the official demo, captions (describe the voice, emotion and manner in Japanese), emoji style control, reference audio (several clips), speaker embeddings (`.speaker.safetensors`), LoRA adapters, several candidates to compare, fixed or random seeds.
- **Voice Studio** — a voice library: design voices from a caption, import or record reference audio (with the speaker's consent recorded), trim and split clips, speaker embeddings, per-voice defaults, and `.irovoice` packages to share voices.
- **Narration** — long text (paste, `.txt` / `.md`, SRT / WebVTT) split into chunks read in one consistent voice; a pronunciation dictionary with a reading preview; re-render single chunks; export the audio with SRT / WebVTT subtitles.
- **Script** — multi-speaker dialogue from "Speaker: line" text or CSV / TSV tables; a voice per speaker; takes per line; per-line files for game engines, the merged drama, subtitles and tables.
- **Library & history** — every generation with its settings: search, filters, generate again, reuse the settings, batch export with file-name templates; parameter presets; projects (`.iroproj`).
- **Output** — WAV, MP3, M4A (AAC), FLAC, Opus; 48 or 44.1 kHz; loudness presets (−14 / −16 / −23 LUFS), tempo and gain.
- **API server** — OpenAI-compatible (`/v1/audio/speech`) and VOICEVOX-compatible endpoints for other apps; this computer only by default, the local network with an API key.
- **Settings** — the storage folder (movable at any time), device and precision, a GPU / memory monitor, the watermark, update notices, logs, licenses.
- UI in Japanese, English, Simplified Chinese and German. **The model reads Japanese text only.**

## Requirements

|  | Windows | macOS |
| --- | --- | --- |
| OS | Windows 10 / 11 (64-bit) | macOS 14 or later |
| Processor / GPU | NVIDIA GPU, Volta or newer, with 6 GB of VRAM or more (8 GB recommended; 6–8 GB cards use bf16 automatically). Without one, the app runs in **CPU mode**, which is much slower. | Apple Silicon **M2 or later** (M1 runs with an "unsupported" warning) |
| Memory | — | 16 GB recommended (8 GB works, more slowly) |
| Disk | About 15 GB (runtime about 8 GB + models about 4 GB), plus your history and exports | About 8 GB, plus your history and exports |
| Network | Needed for the first-run setup; afterwards the app works offline | Same |

With an NVIDIA GPU, a recent driver (R570 or newer) is recommended for the CUDA 12.8 runtime the app installs.

## Installation

### Windows

1. Download `irodori-studio_<version>_x64-setup.exe` from [Releases](https://github.com/appdevelopmentworks/irodori-studio/releases).
2. Run it. The installer is not code-signed, so Windows SmartScreen may show "Windows protected your PC": click **More info**, then **Run anyway**.
3. Start **irodori-studio** from the Start menu.

### macOS (Apple Silicon)

1. Download `irodori-studio_<version>_aarch64.dmg` from [Releases](https://github.com/appdevelopmentworks/irodori-studio/releases).
2. Open it and drag **irodori-studio** into **Applications**.
3. The app is signed ad hoc but not notarized by Apple. Before the first launch, run this in Terminal (otherwise macOS says the app "is damaged" or "cannot be opened"):

   ```bash
   xattr -dr com.apple.quarantine "/Applications/irodori-studio.app"
   ```

4. Start the app. macOS asks for microphone access the first time you record a voice.

### First-run setup

A setup wizard guides you through:

1. **Language** and **terms of use**, including the model's ethical restrictions ([below](#ethics-and-terms)).
2. **Your computer:** GPU (CUDA or Apple Silicon) or CPU mode, and the precision. You can choose CPU mode explicitly.
3. **Storage folder:** where everything goes — runtime, models, voices, history (about 15 GB).
4. **Install:** the app downloads its own Python, its packages, PyTorch for your hardware (the CUDA 12.8 build, the CPU build, or the macOS build) and the models (about 3.6 GB) from Hugging Face, then tests the GPU. This can take a while; an interrupted setup continues where it stopped.

Then the model loads and the Quick generation screen opens with a sample sentence. Nothing is installed system-wide: the app and its storage folder are all there is.

## Using the app

- **Quick generation:** type Japanese text (up to 2,000 characters), optionally a caption and a voice, then **Generate** (`Ctrl` / `⌘` + `Enter`). Compare the candidates, adopt one, save it. Every generation is kept in **Library & history**.
- **Voice Studio:** make a voice once — from a caption, from reference audio (≈ 30 s of clean speech works best), or from a speaker embedding — give it defaults, and pick it anywhere else.
- **Narration:** paste or open a manuscript, check the chunks and readings, render, fix single chunks, then export the audio and subtitles.
- **Script:** paste "Name: line" text or open a CSV / TSV table, assign a voice to each speaker, render, and export per-line files or the whole drama.
- **Shortcuts:** `Ctrl` / `⌘` + `1`–`7` switches screens, `Ctrl` / `⌘` + `,` opens Settings.

## API server

Other apps can use the app's voices while it runs. Turn it on in **API server** (off by default; `http://127.0.0.1:50221`). Requests share the app's queue and run one at a time.

**OpenAI-compatible** — for example with the OpenAI Python SDK:

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:50221/v1", api_key="unused")

with client.audio.speech.with_streaming_response.create(
    model="irodori-tts",
    voice="none",  # or the name / ID of a voice in your library
    input="こんにちは。今日はいい天気ですね。",
    response_format="wav",
    extra_body={"irodori": {"seed": 42}},
) as response:
    response.stream_to_file("speech.wav")
```

Formats `wav`, `mp3`, `flac`, `opus`, `aac`, `pcm`; `speed` from 0.25 to 4; long text is split automatically; `stream_format: "sse"` streams one chunk at a time. Captions and sampling parameters go in the `irodori` extension field.

**VOICEVOX-compatible** — in an app that supports the VOICEVOX engine API, set the engine URL to `http://127.0.0.1:50221`. Your library voices appear as speakers, with "ノーマル" (the voice as saved) and the style presets as styles. Speed, volume, silence before / after, sampling rate and stereo are applied; pitch, intonation, pauses and accent edits are not.

To use it from other devices, choose **Local network (LAN)**: an API key is then required (`Authorization: Bearer <key>` or `X-API-Key: <key>`), and your firewall may ask you to allow the connection. The full contract is in [`docs/api-spec.md`](docs/api-spec.md).

## Where your data lives

- **Storage folder** (chosen during setup; shown in **Settings → Storage**): the runtime (Python, PyTorch), the models, the database (voices, history, narrations, scripts, presets), audio, projects and logs. By default:
  - Windows: `%LOCALAPPDATA%\com.aileap.irodori-studio\data`
  - macOS: `~/Library/Application Support/com.aileap.irodori-studio/data`

  To move it to another folder or drive, use **Settings → Storage → Move** — it copies, verifies and then switches; the old folder stays until you delete it. Do not move the folder by hand.
- **Settings file:** `%APPDATA%\com.aileap.irodori-studio\settings.json` (Windows), `~/Library/Application Support/com.aileap.irodori-studio/settings.json` (macOS).

### Uninstalling

- **Windows:** Settings → Apps → irodori-studio → Uninstall.
- **macOS:** quit the app and move it from Applications to the Trash.

To remove everything, also delete the storage folder and the settings file above. Closing the app always stops its background engine; no processes are left running.

## Troubleshooting

| Problem | What to do |
| --- | --- |
| Setup stops with an error | Check your connection and free disk space, then press **Retry** — setup continues where it stopped. The details are in the log (**Show the log**). |
| "CPU mode" is shown | No usable NVIDIA GPU was found (none, older than Volta, or less than 6 GB of VRAM). CPU mode works, only slowly. After adding a GPU or updating its driver, restart the app and use **Repair the installation** (Settings → Model & device): setup checks the hardware again and installs the GPU build of PyTorch — unless you chose CPU mode yourself. |
| "Out of memory" | Use fewer candidates or shorter text, or try **bf16** in **Settings → Model & device** (Ampere or newer GPUs). |
| The app shows an error instead of starting | **Retry**; if that does not help, **Repair the installation** (re-checks the packages and model files, needs the internet), and look at the log. |
| A red banner says the GPU reported an error | Press **Restart the engine**. |
| Words are read wrongly | Add them to the user dictionary (Narration or Script) and check the reading preview. |
| The API server does not start | The port is in use: choose another port on the **API server** screen. |
| Other devices cannot reach the API server | Choose **Local network (LAN)**, set an API key, and allow the connection in your firewall. |
| The disk is full | Free up space, or move the storage folder to another drive (**Settings → Storage**). |
| macOS says the app is damaged | Run the `xattr` command from [Installation](#macos-apple-silicon). |
| Security software blocks or removes the installer or the app | The installer and the app are not code-signed, so behavior-based protection may flag them, most likely while installing or uninstalling. If you downloaded the installer from this project's [Releases](https://github.com/appdevelopmentworks/irodori-studio/releases) page, restore the files from your security software's quarantine and report the detection to its vendor as a false positive. |

Logs are in **Settings → Logs** (`sidecar.log` for the engine, `setup.log` for setup) and in the `logs` folder of the storage folder. Please attach them when you [report a problem](https://github.com/appdevelopmentworks/irodori-studio/issues).

## Ethics and terms

Irodori-TTS is released under the MIT license together with these **ethical restrictions** from its [model card](https://huggingface.co/Aratako/Irodori-TTS-v4.1-Small); you accept them in the setup wizard:

1. **No impersonation:** do not clone or impersonate the voice of anyone (voice actors, celebrities, public figures, …) without their explicit consent.
2. **No misinformation:** do not generate deepfakes or speech intended to mislead others or spread misinformation.
3. **Voice generation disclaimer:** a voice generated from text or a caption alone may coincidentally resemble a real person's.
4. **Liability disclaimer:** the developers accept no liability for misuse; you are responsible for complying with the laws that apply to you.

In the app, voices made from a real person's recordings require a consent confirmation, which is stored with the voice and travels with its package. Generated audio carries an inaudible **watermark** (SilentCipher) by default so that it can be identified as AI-generated; if you turn it off in Settings and publish the audio, state clearly that it is AI-generated.

## Privacy

The app sends no telemetry. It connects to the internet only to:

- download its runtime and models during setup (Python via uv, PyPI, download.pytorch.org, Hugging Face) and when you repair the installation;
- check GitHub Releases for a newer version at startup (can be turned off in Settings);
- serve other apps when you turn on the API server (this computer only, unless you choose the local network).

## Building from source

Prerequisites: [Node.js](https://nodejs.org/) 24, [Rust](https://rustup.rs/) (stable), [uv](https://docs.astral.sh/uv/) 0.12.5, Git, and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your platform. In development, formats other than WAV need `ffmpeg` on your `PATH`, or the one staged for [installers](#installers).

```bash
git clone --recurse-submodules https://github.com/appdevelopmentworks/irodori-studio.git
cd irodori-studio
npm install
npm run tauri dev
```

The first launch runs the same setup wizard as the installed app. Checks:

```bash
npm run lint
npm run check:i18n
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets
cargo test --manifest-path src-tauri/Cargo.toml
cd sidecar
uv sync
uv run ruff check .
uv run pytest -m "not gpu"
```

Contributors: start with [`CLAUDE.md`](CLAUDE.md) and the documents in [`docs/`](docs/).

### Installers

An installer bundles the sidecar with the pinned `irodori_tts`, uv and an LGPL ffmpeg. Stage them into `resources/` first, then build:

```bash
# Windows (PowerShell): downloads uv and BtbN's LGPL ffmpeg build, checked against their checksums
powershell -ExecutionPolicy Bypass -File scripts\stage-runtime.ps1
# macOS: downloads uv and builds ffmpeg with LAME and Opus from source
# (needs the Xcode command line tools and pkg-config)
scripts/stage-runtime.sh

npm run tauri build
```

The installer is written to `src-tauri/target/release/bundle/` (`nsis/` on Windows, `dmg/` on macOS). Before bundling, the build generates `resources/licenses/rust-crates.md` (the Rust crates in the app, with their licenses) and stops if `resources/` is not staged. Pushing a `v*` tag runs the same steps for both platforms on GitHub Actions ([`release.yml`](.github/workflows/release.yml)) and attaches the installers to a draft release.

## License

- This app: [MIT](LICENSE).
- Irodori-TTS (code and model weights) and the Semantic-DACVAE-Japanese-32dim codec by Aratako: MIT. SilentCipher (Sony): MIT.
- Other components: [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md). The complete list of Python packages in the runtime, with their licenses, is in **Settings → About**.

## Acknowledgments

- [Aratako](https://huggingface.co/Aratako) for Irodori-TTS, its models, the Semantic-DACVAE-Japanese codec, and Irodori-TTS-Server, whose API this app follows.
- [SilentCipher](https://github.com/sony/silentcipher) (Sony), [DACVAE](https://github.com/facebookresearch/dacvae) (Meta), [pyopenjtalk-plus](https://github.com/tsukumijima/pyopenjtalk-plus) and Open JTalk, [Sudachi](https://github.com/WorksApplications/sudachi.rs), [Tauri](https://tauri.app/), [uv](https://github.com/astral-sh/uv).
- OpenAI and VOICEVOX are named only to describe API compatibility. This project is not affiliated with or endorsed by them, or by the Irodori-TTS authors.
