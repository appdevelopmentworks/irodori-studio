# irodori-studio (working name)

> Status: requirements / design phase. No release yet. The public README (install steps, first-launch approval, troubleshooting) is written in Session 10 — see `docs/session-plan.md`.

Unofficial desktop app for the Japanese TTS model [Irodori-TTS](https://github.com/Aratako/Irodori-TTS) by Aratako. Windows (NVIDIA GPU or CPU) and macOS (Apple Silicon M2+).

日本語TTSモデル [Irodori-TTS](https://github.com/Aratako/Irodori-TTS) を使う非公式デスクトップアプリです（Windows / Mac対応、開発中）。

## Planned features

- Full parity with the official Hugging Face demo (all parameters, emoji palette, captions, multi-clip reference audio, candidates)
- Voice Studio: design voices by caption, import or record reference audio (with consent), speaker embeddings, LoRA
- Long-form narration with chunking, pronunciation dictionary, subtitles (SRT/VTT)
- Multi-speaker scripts with per-line takes and batch export
- Local API server compatible with OpenAI TTS and VOICEVOX Engine clients
- UI in Japanese, English, Chinese, German

## For developers

Start with `CLAUDE.md` (or `AGENTS.md`) and `docs/`.

## Ethics

This app follows the upstream model's ethical restrictions: do not clone anyone's voice without explicit consent, and do not create deceptive content. Generated audio is watermarked by default.
