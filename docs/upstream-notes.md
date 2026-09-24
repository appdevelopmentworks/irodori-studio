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
- Watermark: Sony SilentCipher, applied automatically at the end of every generation when it loaded; upstream has no switch (verified S2; how the app skips it: decisions.md, S2).
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
runtime.model_cfg.use_speaker_condition_resolved   # True for v4.1-Small (verified S2)
runtime.unload()
```

- `RuntimeKey`: `checkpoint, model_device, codec_repo, model_precision="fp32", codec_device="cpu", codec_precision="fp32", codec_deterministic_encode=True, codec_deterministic_decode=True, compile_model=False, compile_dynamic=False`. The codec defaults to **CPU** — always set `codec_device` explicitly.
- `SamplingRequest`: `text, caption, ref_wav, ref_wavs, ref_latent, ref_latents, ref_embed, no_ref, ref_normalize_db=-16.0, ref_ensure_max=True, num_candidates=1, decode_mode="sequential", seconds, duration_scale=1.0, min_seconds=0.5, max_seconds=30.0, max_ref_seconds (None = checkpoint recommendation), max_text_len, max_caption_len, num_steps (None = checkpoint default), cfg_scale_text=3.0, cfg_scale_caption=3.0, cfg_scale_speaker=5.0, cfg_guidance_mode="independent", cfg_scale, cfg_min_t=0.5, cfg_max_t=1.0, truncation_factor, rescale_k, rescale_sigma, context_kv_cache=True, speaker_kv_scale, speaker_kv_min_t, speaker_kv_max_layers, speaker_uncond_mode="mask", seed, t_schedule_mode="linear", sway_coeff=-1.0, trim_tail=True, tail_window_size=20, tail_std_threshold=0.05, tail_mean_threshold=0.1, lora_adapter`.
- CLI equivalents: `--ref-embed` → `ref_embed`, `--speaker-uncond-mode` → `speaker_uncond_mode`, `--lora-adapter` → `lora_adapter` (all per request); `--compile-model` / `--compile-dynamic` → `RuntimeKey`. The runtime default `cfg_scale_caption` is 3.0; the Space uses 4.0 (D26: follow the Space).
- Emoji palette data: `EMOJI_PALETTE_ITEMS` in `irodori_tts/gradio_emoji_palette.py` — 45 × `EmojiPaletteItem(emoji, label, description)` with Japanese label/description. That module imports `gradio` at the top, and gradio is not installed (decisions.md, S0), so read the constant without importing the module.

Verified in Session 2 (`inference_runtime.py`, `rf.py`, `meanflow.py`, `watermark.py`, `lora.py`):
- **Watermark:** `InferenceRuntime.__init__` creates `SilentCipherWatermarker(device=codec_device)`; `synthesize` runs `watermarker.encode_batch` after decoding when `watermarker.ready`, else appends the message `warning: SilentCipher watermark is unavailable; …`. No flag or constructor option.
- **Hooks:** `synthesize(req, *, log_fn=None)` is the only callback. The samplers have no progress or cancel hook; they call `model.forward_with_encoded_conditions(..., t=...)` through the instance attribute, once per step in `independent` CFG mode and up to twice in `joint` / `alternating` (every step has a distinct, strictly decreasing `t`). `synthesize` holds `runtime._infer_lock`, the LoRA context and `torch.inference_mode()` as context managers, so an exception raised inside sampling unwinds cleanly.
- **Validation:** bad inputs raise `ValueError` (text empty after normalization, `joint` guidance with unequal enabled scales, `rescale_k` without `rescale_sigma`, non-positive `duration_scale` / `truncation_factor`, …). A manual `seconds` is clamped to `[min_seconds 0.5, max_seconds 30]` with a warning. The duration predictor's frame count is averaged over candidates, so all candidates of one request share one length.
- **Seeds:** `seed=None` draws `secrets.randbits(63)`; the app passes explicit seeds ≤ 2^53−1 instead (decisions.md, S2).
- **MeanFlow:** chosen from the checkpoint's `flow_parameterization` metadata; default 4 steps; runtime CFG (scales, mode, time bounds) and speaker K/V scaling are ignored; `sample_euler_meanflow` uses a linear schedule (no Sway).
- **LoRA:** `lora_adapter` loads a PEFT adapter dynamically (`PeftModel` wraps the model; adapters are cached per path; requests without one run under `disable_adapter()`); rejected when `compile_model` is on.
- **Stage timings** (`SamplingResult.stage_timings`, seconds): `prepare_lora` (with LoRA), `tokenize_text`, `prepare_reference`, `predict_duration`, `sample_rf` / `sample_meanflow`, `unpatchify_latent`, `decode_latent`, `silentcipher_watermark`; plus `total_to_decode`.
- **Loading:** `InferenceRuntime.from_key` builds the ModernBERT backbone from the config embedded in the safetensors metadata (`AutoConfig.for_model`, no download), finds the bundled tokenizer next to the checkpoint, and loads the codec from a local `weights.pth`; SilentCipher resolves `sony/silentcipher` from the Hugging Face cache (it prints "Downloading the model from the Hugging Face Hub..." even when offline).

## Dependencies (verified S0)

- `.python-version`: **3.10**.
- Base dependencies include the torch family: `torch>=2.10.0`, `torchaudio>=2.10.0`, `torchcodec>=0.10.0,<0.11.0`, `torchdata>=0.11.0`. The `cpu` / `cu128` / `rocm` / `xpu` extras pin torch + torchaudio 2.10.x, torchcodec 0.10.x and torchao 0.16.x from `download.pytorch.org/whl/{cpu,cu128,rocm7.1,xpu}` — the tested combination to start from in Session 1 (D2).
- Git dependencies: `dacvae` (facebookresearch, commit `414c207…` in upstream's lock; brings `descript-audiotools` 0.7.2, which `ref_normalize_db` requires) and `silentcipher` (SesameAILabs fork, commit `d46d7d0…`).
- The `irodori_tts` package never imports `datasets`, `wandb` or `torchdata` (training scripts only). `flash_attn_interface` is an optional try-import; `torchao` is imported lazily for quantized checkpoints only.
- Audio I/O (verify in Session 1/2): `inference_runtime._load_audio` and `DACVAECodec.encode_file` call `torchaudio.load` and fall back to `soundfile` only on `RuntimeError`; `save_wav` does the same for `torchaudio.save`. torchaudio ≥ 2.9 routes `load`/`save` through TorchCodec, so check what torchaudio 2.10 raises without `torchcodec` (or without the FFmpeg libraries it needs). Either install `torchcodec` with torch, or have the adapter pass decoded waveforms or latents instead of file paths.
- Our sidecar venv without torch: ≈ 560 MB on Windows (Python 3.10.19, 122 locked packages).

## Runtime environment (verified S1 on Windows 11 + RTX 5090, driver 610.88)

- First-run setup installed Python 3.10.21 (uv-managed), torch/torchaudio `2.10.0+cu128`, torchcodec `0.10.0`; `torch.cuda.get_arch_list()` = `sm_70, sm_75, sm_80, sm_86, sm_90, sm_100, sm_120` → the cu128 wheel supports Volta and newer (D2). CUDA kernels run on sm_120 (Blackwell).
- Downloads (fast connection): whole setup ≈ 3 min; model + codec + SilentCipher = 22 files, 3.57 GB. Switching CPU ⇄ CUDA re-installs torch from the uv cache in ≈ 20 s.
- **Audio I/O:** without FFmpeg shared libraries, `torchaudio.load` raises `RuntimeError: Could not load libtorchcodec…`, which is exactly the type upstream's `_load_audio` / `DACVAECodec.encode_file` catch → they fall back to `soundfile` (WAV/FLAC/OGG only). Sessions 2/4: convert other formats (mp3, m4a, webm from the recorder) to WAV with the bundled ffmpeg before handing paths to upstream.
- **Local paths for upstream** (Session 2 adapter): pass `RuntimeKey.checkpoint = <models>/pinned/Aratako--Irodori-TTS-v4.1-Small/<commit>/model.safetensors` — the bundled tokenizer is found in the sibling `tokenizer/` — and `codec_repo = <…>/Aratako--Semantic-DACVAE-Japanese-32dim/<commit>/weights.pth` (`DACVAECodec.load` accepts an existing path). No network needed.
- **SilentCipher:** `SilentCipherWatermarker` calls `silentcipher.get_model(model_type="44.1k", device=…)`, whose default checkpoint paths are relative and missing, so it runs `snapshot_download(repo_id="sony/silentcipher")` (branch `main`). Offline, that resolves through `refs/main` in the HF cache, which setup writes. If loading fails, upstream only logs a warning and **generates without a watermark** — Session 2 must check `runtime.watermarker.ready` so D12's default-ON cannot silently lapse.
- **huggingface_hub 1.23** does not resume interrupted downloads (each attempt writes a uniquely named `*.incomplete`; a hard kill orphans it), and hf_xet kept no chunk cache here. On Windows without the symlink privilege, cached files live directly in `snapshots/` (not `blobs/`). Hence our own resumable downloader for pinned repos (decisions.md, S1).
- **Windows venv:** `<venv>/Scripts/python.exe` is a launcher that starts the base interpreter as a child, so every sidecar is two processes — always kill the tree (job object), never just the launcher.
- **Threading pitfall:** on Windows, a thread blocked reading a piped stdin makes `import torch` in another thread hang forever.

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

Measured in this app (Session 2, Windows 11, RTX 5090, fp32, 40 steps, ~4 s of audio): cold model load 20.5 s, ≈ 5.3 GB VRAM in use; predict_duration 30–150 ms, sample_rf 610–830 ms, decode_latent 22–55 ms, watermark 9–48 ms; 0.7–1.1 s per request end to end, 4 candidates ≈ 1.0 s; reference-clip encode ≈ 0.19 s (cached afterwards). Same seed → byte-identical output.

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
