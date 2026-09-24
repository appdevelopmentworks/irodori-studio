"""Export post-processing (D20) through the ffmpeg on PATH: every format decodes at the
chosen sample rate, loudness presets land within ±1 LU of their target, tempo changes
the length, gain the level. Skipped without ffmpeg."""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf
from conftest import read_events, wait_ready

from app.audio import export, post
from app.text import srt

FFMPEG = shutil.which("ffmpeg")
FFPROBE = shutil.which("ffprobe")
pytestmark = pytest.mark.skipif(FFMPEG is None, reason="ffmpeg is not on PATH")


def _speech_like(path: Path, seconds: float = 6.0, level: float = 0.05) -> Path:
    """Noise shaped into syllables and pauses, at a quiet level (about -35 LUFS)."""
    rate = 48_000
    t = np.arange(int(seconds * rate)) / rate
    rng = np.random.default_rng(1)
    syllables = 0.5 * (1 + np.sin(2 * np.pi * 4.0 * t)) * (np.sin(2 * np.pi * 0.4 * t) > -0.3)
    signal = level * rng.standard_normal(len(t)) * syllables
    sf.write(str(path), signal.astype(np.float32), rate, subtype="PCM_16")
    return path


def _probe(path: Path) -> dict:
    assert FFPROBE is not None
    result = subprocess.run(
        [FFPROBE, "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)],
        capture_output=True,
        check=True,
    )
    return json.loads(result.stdout)


def _decodes(path: Path) -> None:
    """The file plays: ffmpeg decodes it end to end without errors."""
    assert FFMPEG is not None
    result = subprocess.run(
        [FFMPEG, "-v", "error", "-i", str(path), "-f", "null", "-"], capture_output=True
    )
    assert result.returncode == 0 and not result.stderr, result.stderr


@pytest.mark.parametrize("fmt", ["wav", "mp3", "m4a", "flac", "opus"])
def test_formats_decode_at_the_chosen_rate(tmp_path: Path, fmt: str) -> None:
    source = _speech_like(tmp_path / "take.wav")
    dest = tmp_path / f"out{export.EXTENSIONS[fmt]}"
    options = post.Post(sample_rate=44_100, loudness=-16)
    export.export_audio(source, dest, fmt, ffmpeg=Path(FFMPEG), post=options)  # type: ignore[arg-type]
    _decodes(dest)
    expected_rate = 48_000 if fmt == "opus" else 44_100  # Opus is always 48 kHz
    if FFPROBE:
        stream = _probe(dest)["streams"][0]
        assert int(stream["sample_rate"]) == expected_rate
        assert float(_probe(dest)["format"]["duration"]) == pytest.approx(6.0, abs=0.1)
    loudness = post.integrated_loudness(Path(FFMPEG), dest)  # type: ignore[arg-type]
    assert loudness == pytest.approx(-16, abs=1.0)


@pytest.mark.parametrize("target", [-14, -16, -23])
def test_loudness_presets_within_one_lu(tmp_path: Path, target: int) -> None:
    source = _speech_like(tmp_path / "take.wav")
    dest = tmp_path / "out.wav"
    export.export_audio(source, dest, "wav", ffmpeg=Path(FFMPEG), post=post.Post(loudness=target))  # type: ignore[arg-type]
    assert sf.info(str(dest)).samplerate == 48_000
    assert post.integrated_loudness(Path(FFMPEG), dest) == pytest.approx(target, abs=1.0)  # type: ignore[arg-type]


def test_tempo_gain_and_plain_copy(tmp_path: Path) -> None:
    ffmpeg = Path(FFMPEG)  # type: ignore[arg-type]
    source = _speech_like(tmp_path / "take.wav")
    before = post.integrated_loudness(ffmpeg, source)

    faster = tmp_path / "faster.wav"
    export.export_audio(source, faster, "wav", ffmpeg=ffmpeg, post=post.Post(tempo=1.25))
    assert sf.info(str(faster)).duration == pytest.approx(6.0 / 1.25, rel=0.02)

    louder = tmp_path / "louder.wav"
    export.export_audio(source, louder, "wav", ffmpeg=ffmpeg, post=post.Post(gain_db=6.0))
    assert post.integrated_loudness(ffmpeg, louder) == pytest.approx(before + 6.0, abs=0.3)

    # Gain is ignored when loudness is set.
    both = tmp_path / "both.wav"
    export.export_audio(
        source, both, "wav", ffmpeg=ffmpeg, post=post.Post(loudness=-23, gain_db=6.0)
    )
    assert post.integrated_loudness(ffmpeg, both) == pytest.approx(-23, abs=1.0)

    copy = tmp_path / "copy.wav"
    export.export_audio(source, copy, "wav", ffmpeg=None, post=post.Post())
    assert copy.read_bytes() == source.read_bytes()
    with pytest.raises(export.ExportError) as missing:
        export.export_audio(source, tmp_path / "x.wav", "wav", ffmpeg=None, post=post.Post(tempo=2))
    assert missing.value.code == "ffmpeg_unavailable"
    assert post.retimed(1000, post.Post(tempo=2.0)) == 500 and post.retimed(1000, None) == 1000


def test_exports_apply_post_and_retime_subtitles(make_client, tmp_path: Path) -> None:
    client, _ = make_client(IRODORI_FFMPEG=FFMPEG)
    wait_ready(client)
    options = {"sample_rate": 44100, "tempo": 2.0, "gain_db": 3.0}

    script = client.post(
        "/scripts", json={"source": "A：一。\nB：二。", "title": "t", "settings": {"pause_ms": 400}}
    ).json()
    read_events(client, client.post(f"/scripts/{script['id']}/render", json={}).json()["job_id"])
    folder = tmp_path / "script"
    folder.mkdir()
    exported = client.post(
        f"/scripts/{script['id']}/export",
        json={"folder": str(folder), "format": "flac", "subtitles": ["srt"], "post": options},
    )
    assert exported.status_code == 200, exported.text
    names = sorted(Path(f["path"]).name for f in exported.json()["files"])
    assert names == ["001_A_一。.flac", "002_B_二。.flac", "t.flac", "t.srt"]
    assert sf.info(str(folder / "t.flac")).samplerate == 44_100
    assembled = client.get(f"/scripts/{script['id']}").json()["assembled"]
    cues = srt.parse((folder / "t.srt").read_text(encoding="utf-8"))
    assert [(c.start_ms, c.end_ms) for c in cues] == [
        (round(c["start_ms"] / 2), round(c["end_ms"] / 2)) for c in assembled["cues"]
    ]
    merged = sf.info(str(folder / "t.flac")).duration
    assert merged == pytest.approx(assembled["duration_s"] / 2, abs=0.03)

    narration = client.post(
        "/narrations",
        json={"source": "一つ目です。二つ目です。", "rules": {"min_chars": 1, "max_chars": 20}},
    ).json()
    read_events(
        client, client.post(f"/narrations/{narration['id']}/render", json={}).json()["job_id"]
    )
    saved = client.post(
        f"/narrations/{narration['id']}/export",
        json={"path": str(tmp_path / "n.wav"), "subtitles": ["vtt"], "post": options},
    ).json()
    assert [Path(f["path"]).name for f in saved["files"]] == ["n.wav", "n.vtt"]
    assembled = client.get(f"/narrations/{narration['id']}").json()["assembled"]
    vtt = srt.parse((tmp_path / "n.vtt").read_text(encoding="utf-8"))
    assert vtt[-1].end_ms == round(assembled["cues"][-1]["end_ms"] / 2)
