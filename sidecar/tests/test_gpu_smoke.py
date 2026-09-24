"""TorchBackend against the real model (marker `gpu`; excluded from CI).

Needs a provisioned data root (first-run setup done) and a venv with torch, e.g. the
app's runtime venv with pytest added:

    uv pip install --python <data-root>/runtime/venv/Scripts/python.exe pytest
    IRODORI_TEST_DATA_ROOT=<data-root> <venv-python> -m pytest -m gpu tests/test_gpu_smoke.py

`IRODORI_TEST_DEVICE` (cuda / mps / cpu) overrides the device; the default is the best
available one.
"""

from __future__ import annotations

import os
from pathlib import Path

import numpy as np
import pytest

pytestmark = pytest.mark.gpu

DATA_ROOT = os.environ.get("IRODORI_TEST_DATA_ROOT")
if DATA_ROOT:
    # Must be set before huggingface_hub is imported (SilentCipher resolves from the cache).
    os.environ.setdefault("HF_HOME", str(Path(DATA_ROOT) / "models"))
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")

from app.engine import params  # noqa: E402
from app.engine.base import (  # noqa: E402
    BackendHooks,
    BackendRequest,
    RuntimeOptions,
    SynthesisCancelled,
)
from app.engine.registry import load_registry  # noqa: E402

TEXT = "こんにちは、これは動作確認のための音声です。"
SPEC = load_registry().default


@pytest.fixture(scope="module")
def backend():  # type: ignore[no-untyped-def]
    if not DATA_ROOT:
        pytest.skip("IRODORI_TEST_DATA_ROOT is not set")
    torch = pytest.importorskip("torch")
    from app.engine.irodori_adapter import TorchBackend

    device = os.environ.get("IRODORI_TEST_DEVICE")
    if device is None:
        mps = getattr(torch.backends, "mps", None)
        if torch.cuda.is_available():
            device = "cuda"
        elif mps is not None and mps.is_available():
            device = "mps"
        else:
            device = "cpu"
    instance = TorchBackend()
    options = RuntimeOptions(device=device, codec_device=device)
    instance.load(SPEC, options, Path(DATA_ROOT) / "models")
    yield instance
    instance.unload()


def _request(**overrides: object) -> BackendRequest:
    provided = overrides.pop("params", {})
    reference_kind = "clips" if overrides.get("ref_latents") else "none"
    values = params.resolve(
        provided,  # type: ignore[arg-type]
        SPEC.capabilities,
        reference_kind=reference_kind,
        has_caption=bool(overrides.get("caption")),
    )
    values.pop("seed")
    fields = {"text": TEXT, "caption": None, "params": values, "seed": 1234, **overrides}
    return BackendRequest(**fields)  # type: ignore[arg-type]


def test_generates_watermarked_audio(backend) -> None:  # type: ignore[no-untyped-def]
    assert backend.watermark_ready, "SilentCipher did not load (D12)"
    result = backend.synthesize(_request(), BackendHooks())
    assert result.sample_rate == 48000
    assert len(result.audios) == 1
    seconds = result.audios[0].size / result.sample_rate
    assert 1.0 < seconds < SPEC.capabilities.max_output_seconds
    assert {"sample_rf", "decode_latent", "silentcipher_watermark"} <= set(result.timings)
    assert result.watermarked and result.used_seed == 1234


def test_same_seed_reproduces(backend) -> None:  # type: ignore[no-untyped-def]
    first = backend.synthesize(_request(seed=7), BackendHooks())
    second = backend.synthesize(_request(seed=7), BackendHooks())
    other = backend.synthesize(_request(seed=8), BackendHooks())
    assert np.array_equal(first.audios[0], second.audios[0])
    assert not np.array_equal(first.audios[0], other.audios[0])


def test_watermark_off_skips_the_stage(backend) -> None:  # type: ignore[no-untyped-def]
    lines: list[str] = []
    result = backend.synthesize(_request(watermark=False), BackendHooks(on_log=lines.append))
    assert "silentcipher_watermark" not in result.timings
    assert not result.watermarked
    assert not any("SilentCipher watermark is unavailable" in line for line in lines)
    assert not any("SilentCipher" in message for message in result.messages)
    # The real watermarker is back for the next request.
    assert backend.watermark_ready


def test_progress_and_cancel_mid_sampling(backend) -> None:  # type: ignore[no-untyped-def]
    progress: list[tuple[int, int]] = []
    backend.synthesize(
        _request(params={"num_steps": 12}),
        BackendHooks(on_progress=lambda done, total: progress.append((done, total))),
    )
    assert progress == [(step, 12) for step in range(13)]

    seen: list[int] = []
    with pytest.raises(SynthesisCancelled):
        backend.synthesize(
            _request(),
            BackendHooks(
                on_progress=lambda done, _total: seen.append(done),
                is_cancelled=lambda: len(seen) >= 5,
            ),
        )
    assert seen == [0, 1, 2, 3, 4]
    # The runtime is intact after an aborted run.
    assert backend.synthesize(_request(params={"num_steps": 8}), BackendHooks()).audios


def test_candidates_with_caption(backend) -> None:  # type: ignore[no-untyped-def]
    result = backend.synthesize(
        _request(caption="明るく元気な若い女性の声", params={"num_candidates": 4}),
        BackendHooks(),
    )
    assert len(result.audios) == 4
    assert all(audio.size > 0 for audio in result.audios)


def test_reference_latent_round_trip(backend, tmp_path: Path) -> None:  # type: ignore[no-untyped-def]
    import soundfile as sf

    voice = backend.synthesize(_request(seed=99), BackendHooks()).audios[0]
    clip = tmp_path / "clip.wav"
    sf.write(str(clip), voice, 48000, subtype="FLOAT")
    latent = tmp_path / "clip.pt"
    backend.encode_reference(clip, latent, normalize_db=-16.0, ensure_max=True, max_seconds=120.0)
    assert latent.stat().st_size > 0
    result = backend.synthesize(
        _request(ref_latents=(latent,), caption="ささやくように"), BackendHooks()
    )
    assert result.audios[0].size > 0
