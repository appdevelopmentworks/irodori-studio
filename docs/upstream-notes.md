# Upstream notes (Irodori-TTS facts)

Facts gathered on 2026-09-23 from upstream sources and community reports, so sessions do not need to re-research. **Re-verify anything marked (verify) against the pinned submodule commit** before relying on it. When the submodule is bumped, update this file.

**Pinned submodule commit:** `89f9d8fbd4d51ea019867ee1197725ede1df13c5` (upstream `main`, 2026-09-12, "Add MeanFlow distillation and v4-Large support"). Sections marked "verified S0" were checked against this commit.

Sources:
- Code: https://github.com/Aratako/Irodori-TTS (README, `docs/parameters.md`, `gradio_app.py`, `irodori_tts/inference_runtime.py`)
- Model card: https://huggingface.co/Aratako/Irodori-TTS-v4.1-Small
- Demo Space (parity target): https://huggingface.co/spaces/Aratako/Irodori-TTS-v4.1-Small-Demo (`app.py`)
- API server: https://github.com/Aratako/Irodori-TTS-Server
- Measurements: https://fixit.co.jp/insights/irodori-tts/ (RTX 4090)

## Model

- `Aratako/Irodori-TTS-v4.1-Small`: ~766M params (0.8B), `model.safetensors` ≈ 3.06 GB (F32), MIT. Unifies the former base + VoiceDesign families: **3-branch conditioning** — text, reference speech, caption.
- v4.1 = v4-Small with a separately retrained duration predictor (fewer over-long outputs). Same inference interface.
- Text/caption encoder: fine-tuned ModernBERT-ja-310m, embedded in the checkpoint + bundled `tokenizer/` (no separate ModernBERT download needed).
- Codec: `Aratako/Semantic-DACVAE-Japanese-32dim` (≈ 0.43 GB), 48 kHz output, 32-dim continuous latents, 25 fps.
- Watermark: Sony SilentCipher applied automatically when the dependency and model files are available (verify how to skip — D12).
- Upstream `main` tracks the v4/v4.1 codebase including MeanFlow and the forthcoming **v4-Large**.
- Related (not offered in v1, D5): `-MF` (MeanFlow distilled, default 4 steps; CFG and Sway do not apply), `-Quantized` (torchao int8/int4/fp8; validated on CUDA only; int4 needs compute capability ≥ 8.0), third-party `phasefield-audio/Irodori-TTS-v4.1-Anime`.

## Limits

- **Japanese text only.**
- **~30 s per generation** (trained max 750 latent frames at 25 fps). ~40 chars → 7.8 s, ~100 chars → 18 s, ~210 chars → truncated at 30.00 s. Keep chunks ≤ ~150 chars (D18).
- Reference audio: up to **120 s** combined; **multiple clean short clips of one speaker** recommended; ~30 s captures most of the similarity gain; a single long recording is accepted but unevaluated. Short single clip → speaker similarity slightly below v3.
- Caption + reference conflicts (e.g. both describing voice timbre) can destabilize output → use caption for emotion/style/scene, reference for identity. Surface this as a UI hint.
- Emoji control: 45 emojis defined in the model repo's `EMOJI_ANNOTATIONS.md`; effect varies with context; repeating an emoji strengthens it; emojis lengthen output (~+1 s for two).
- Kanji readings improved but uncommon names/terms may be misread (→ dictionary, D19).
- `num_candidates` batches **the same text** only (not different lines).

## Runtime API (verified S0, except lines marked (verify))

```python
from irodori_tts.inference_runtime import InferenceRuntime, RuntimeKey, SamplingRequest, download_hf_checkpoint

checkpoint_path = download_hf_checkpoint("Aratako/Irodori-TTS-v4.1-Small")
key = RuntimeKey(checkpoint=checkpoint_path, model_device=dev, codec_repo="Aratako/Semantic-DACVAE-Japanese-32dim",
                 model_precision=prec, codec_device=dev, codec_precision=prec)
runtime = InferenceRuntime.from_key(key)          # module cache: get_cached_runtime(key), clear_cached_runtime()
result = runtime.synthesize(SamplingRequest(...), log_fn=fn)   # log_fn is optional; returns SamplingResult
result.audios          # list of tensors, one per candidate (result.audio = the first)
result.sample_rate     # 48000
result.used_seed
result.stage_timings   # list[(stage, seconds)] — source for our Timings
result.messages
runtime.model_cfg.use_speaker_condition_resolved   # (verify)
runtime.unload()
```

- `RuntimeKey`: `checkpoint, model_device, codec_repo, model_precision="fp32", codec_device="cpu", codec_precision="fp32", codec_deterministic_encode=True, codec_deterministic_decode=True, compile_model=False, compile_dynamic=False`. The codec defaults to **CPU** — always set `codec_device` explicitly.
- `SamplingRequest`: `text, caption, ref_wav, ref_wavs, ref_latent, ref_latents, ref_embed, no_ref, ref_normalize_db=-16.0, ref_ensure_max=True, num_candidates=1, decode_mode="sequential", seconds, duration_scale=1.0, min_seconds=0.5, max_seconds=30.0, max_ref_seconds (None = checkpoint recommendation), max_text_len, max_caption_len, num_steps (None = checkpoint default), cfg_scale_text=3.0, cfg_scale_caption=3.0, cfg_scale_speaker=5.0, cfg_guidance_mode="independent", cfg_scale, cfg_min_t=0.5, cfg_max_t=1.0, truncation_factor, rescale_k, rescale_sigma, context_kv_cache=True, speaker_kv_scale, speaker_kv_min_t, speaker_kv_max_layers, speaker_uncond_mode="mask", seed, t_schedule_mode="linear", sway_coeff=-1.0, trim_tail=True, tail_window_size=20, tail_std_threshold=0.05, tail_mean_threshold=0.1, lora_adapter`.
- CLI equivalents: `--ref-embed` → `ref_embed`, `--speaker-uncond-mode` → `speaker_uncond_mode`, `--lora-adapter` → `lora_adapter` (all per request); `--compile-model` / `--compile-dynamic` → `RuntimeKey`. The runtime default `cfg_scale_caption` is 3.0; the Space uses 4.0 (D26: follow the Space).
- Emoji palette data: `EMOJI_PALETTE_ITEMS` in `irodori_tts/gradio_emoji_palette.py` — 45 × `EmojiPaletteItem(emoji, label, description)` with Japanese label/description. That module imports `gradio` at the top, and gradio is not installed (decisions.md, S0), so read the constant without importing the module.
- Still (verify) for Session 2: how the watermark is applied/skipped (D12 sub-item), progress and cancel hooks (D27), MeanFlow handling at this commit.

## Dependencies (verified S0)

- `.python-version`: **3.10**.
- Base dependencies include the torch family: `torch>=2.10.0`, `torchaudio>=2.10.0`, `torchcodec>=0.10.0,<0.11.0`, `torchdata>=0.11.0`. The `cpu` / `cu128` / `rocm` / `xpu` extras pin torch + torchaudio 2.10.x, torchcodec 0.10.x and torchao 0.16.x from `download.pytorch.org/whl/{cpu,cu128,rocm7.1,xpu}` — the tested combination to start from in Session 1 (D2).
- Git dependencies: `dacvae` (facebookresearch, commit `414c207…` in upstream's lock; brings `descript-audiotools` 0.7.2, which `ref_normalize_db` requires) and `silentcipher` (SesameAILabs fork, commit `d46d7d0…`).
- The `irodori_tts` package never imports `datasets`, `wandb` or `torchdata` (training scripts only). `flash_attn_interface` is an optional try-import; `torchao` is imported lazily for quantized checkpoints only.
- Audio I/O (verify in Session 1/2): `inference_runtime._load_audio` and `DACVAECodec.encode_file` call `torchaudio.load` and fall back to `soundfile` only on `RuntimeError`; `save_wav` does the same for `torchaudio.save`. torchaudio ≥ 2.9 routes `load`/`save` through TorchCodec, so check what torchaudio 2.10 raises without `torchcodec` (or without the FFmpeg libraries it needs). Either install `torchcodec` with torch, or have the adapter pass decoded waveforms or latents instead of file paths.
- Our sidecar venv without torch: ≈ 560 MB on Windows (Python 3.10.19, 122 locked packages).

## Parameter table (parity target = Space; D26)

| Parameter | Space UI | Default | Range / choices | Notes |
| --- | --- | --- | --- | --- |
| text | textbox + emoji palette | — | | required |
| caption | textbox | empty | | optional style prompt |
| reference audio | multi-file, reorderable | none | ≤ 120 s total | blank = no-reference mode |
| num_steps | slider | 40 | 1–120 | main speed/quality knob |
| num_candidates | slider | 1 | 1–32 | VRAM grows with count |
| seed | textbox | random | int | |
| seconds | textbox | auto | float | overrides duration predictor |
| duration_scale | slider | 1.0 | 0.5–1.5 | >1 longer |
| t_schedule_mode | dropdown | linear | linear / sway | |
| sway_coeff | slider | -1.0 | -1.0–1.5 | enabled only for sway |
| cfg_guidance_mode | dropdown | independent | independent / joint / alternating | independent = 1+N NFE; joint/alternating = 2× NFE |
| cfg_scale_text | slider | 3.0 | 0–10 | raise if pronunciation weak |
| cfg_scale_caption | slider | **4.0** (CLI doc: 3.0) | 0–10 | |
| cfg_scale_speaker | slider | 5.0 | 0–10 | forced 0 when no reference |
| cfg_scale | advanced | blank | float | deprecated shared override |
| cfg_min_t / cfg_max_t | advanced | 0.5 / 1.0 | 0–1 | CFG active window |
| context_kv_cache | advanced | true | bool | faster sampling |
| speaker_kv_scale | advanced | blank | float (>1 strengthens) | reference only |
| speaker_kv_min_t | CLI | 0.9 | 0–1 | |
| speaker_kv_max_layers | CLI | none | int | |
| max_text_len / max_caption_len | advanced | checkpoint | int | keep defaults |
| truncation_factor | advanced | blank | e.g. 0.8–0.9 | less variation |
| rescale_k / rescale_sigma | advanced | blank | set both | temporal score rescaling |
| ref_normalize_db | CLI (Space fixed -16) | -16.0 | float / off | keep on |
| ref_ensure_max | CLI (Space fixed true) | true | bool | |
| max_ref_seconds | CLI | checkpoint (120) | float | |
| decode_mode | CLI (Space fixed sequential) | sequential | sequential / batch | batch faster, more VRAM |
| trim_tail | CLI (Space fixed true) | true | bool | + window 20, std 0.05, mean 0.1 |
| speaker_uncond_mode | CLI | mask | mask / noise | embedding only |
| model/codec precision | runtime | fp32 (Space: bf16 on CUDA) | fp32 / bf16 | reload required |
| compile_model / compile_dynamic | runtime | false | bool | incompatible with dynamic LoRA |
| lora_adapter | CLI + local Gradio | none | dir path | dynamic, not merged |
| ref embed (Speaker Inversion) | local Gradio tab | none | `.speaker.safetensors` | same base model required |

## Measured performance (RTX 4090, fixit.co.jp)

| Condition | gen time (7.8 s audio) | VRAM peak |
| --- | --- | --- |
| no ref, 40 steps (default, fp32) | 1.07 s | ~5.5 GB |
| no ref, 16 steps | 0.66 s | ~5.5 GB |
| 6 steps + sway | 0.45 s | ~5.5 GB |
| with reference | 1.49 s (reference encode ≈ 0.45 s → cache latents) | ~5.6 GB |
| bf16 | 1.37 s | ~4.9 GB |
| int8 / int4 (not offered) | ~1.37 s | ~3.2–3.3 GB |

Stage breakdown (40 steps): predict_duration 131 ms, sample_rf 774 ms, decode_latent 84 ms, watermark 75 ms. Cold model load ≈ 16 s per process. CPU fallback: minutes per sentence. Full CUDA venv ≈ 7.8 GB; HF cache ≈ 5 GB.

## macOS / MPS (community reports)

- Install uses the `cpu` extra on macOS (PyPI wheels include MPS).
- M1 Max: fp32 on MPS for both model and codec was fastest after tuning (~2.7× over naive); bf16 on MPS was slower.
- Another report: odd behavior on MPS with default device selection → validate on real M2 hardware in Session 1; be ready to put the codec on CPU.
- An MLX port exists in another project (`mlx-audio`, 8-bit community checkpoint) → future `MlxBackend` reference (D6).

## Ethical restrictions (model card; show in first-run terms)

1. No impersonation: do not clone any individual's voice without explicit consent.
2. No misinformation / deceptive deepfakes.
3. Caption-only voices may coincidentally resemble real people.
4. Developers assume no liability; users are responsible for legal compliance.

## Feature parity checklist (related apps → our screen)

| Source | Feature | Screen |
| --- | --- | --- |
| HF Space / local Gradio | all parameters above, emoji palette, multi-reference ordering, candidates grid, run log | Quick + advanced panel |
| local Gradio | Speaker Inversion embedding input, LoRA adapter | Voice Studio / advanced |
| Irodori-TTS-Server | OpenAI `/v1/audio/speech`, voice library + multi-clip voices, long-text chunking, formats wav/mp3/flac/opus/aac/pcm, `speed`, SSE chunks, per-request LoRA, bearer auth, queue | API Server + Narration |
| BOOTH "Irodori-TTS GUI" | no-Python auto setup, GPU auto-detect, presets, generation history with seed reuse, log saving, steps/sway fast mode | Setup wizard, Library, Settings |
| ComfyUI nodes | rescale correction, LoRA, auto codec selection by latent_dim | advanced panel, registry |
| ComfyUI-Local-Narration-Japanese | reading check before generation, speed/volume/pause controls | Narration (reading preview, pauses), export post-processing |
| Long-text splitter scripts | auto split → generate → join with natural pauses, punctuation fixes | Narration |
| YMM4 integration | use from YukkuriMovieMaker (Gradio URL today) | API Server (VOICEVOX compat in v1; Gradio compat v2) |
| Speaker-Training-GUI | Whisper transcription → manifest → Speaker Inversion training | **v2** |
