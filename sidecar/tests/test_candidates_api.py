"""Candidate handling for the Quick screen: adopt one, save a copy, runtime in /health."""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest
import soundfile as sf
from conftest import generate, read_events, wait_ready


def _completed(client, **body) -> dict:  # type: ignore[no-untyped-def]
    events = read_events(client, generate(client, **body))
    assert events[-1][0] == "completed", events[-1]
    return events[-1][1]


def test_adopt_a_candidate(make_client) -> None:
    client, _ = make_client()
    wait_ready(client)
    result = _completed(client, params={"num_candidates": 3})
    history_id = result["history_id"]
    second = result["outputs"][1]["audio_id"]

    adopted = client.patch(f"/history/{history_id}", json={"adopted_audio_id": second})
    assert adopted.status_code == 200 and adopted.json()["adopted_audio_id"] == second
    assert client.get("/history").json()["items"][0]["adopted_audio_id"] == second

    other = _completed(client)["outputs"][0]["audio_id"]
    foreign = client.patch(f"/history/{history_id}", json={"adopted_audio_id": other})
    assert (foreign.status_code, foreign.json()["code"]) == (404, "audio_not_found")

    cleared = client.patch(f"/history/{history_id}", json={"adopted_audio_id": None})
    assert cleared.json()["adopted_audio_id"] is None
    missing = client.patch("/history/01J0000000000000000000000A", json={"adopted_audio_id": None})
    assert missing.json()["code"] == "history_not_found"


def test_save_a_candidate(make_client, tmp_path: Path) -> None:
    client, _ = make_client()
    wait_ready(client)
    audio_id = _completed(client)["outputs"][0]["audio_id"]

    target = tmp_path / "out" / "take"
    target.parent.mkdir()
    saved = client.post(f"/audio/{audio_id}/save", json={"path": str(target)})
    assert saved.status_code == 200, saved.text
    written = Path(saved.json()["path"])
    assert written == target.with_name("take.wav") and written.is_file()
    data, rate = sf.read(str(written))
    assert rate == 48000 and len(data) == 4800
    assert saved.json()["bytes"] == written.stat().st_size
    assert not list(target.parent.glob(".*.part"))

    # Overwriting is fine (the native dialog asked already).
    assert client.post(f"/audio/{audio_id}/save", json={"path": str(written)}).status_code == 200

    for bad in ("relative.wav", str(tmp_path / "missing" / "x.wav"), str(tmp_path)):
        response = client.post(f"/audio/{audio_id}/save", json={"path": bad})
        assert (response.status_code, response.json()["code"]) == (400, "save_path_invalid"), bad
    unknown = client.post("/audio/nope/save", json={"path": str(tmp_path / "x.wav")})
    assert unknown.json()["code"] == "audio_not_found"


def test_health_reports_the_runtime(make_client) -> None:
    client, _ = make_client(IRODORI_DEVICE="cpu", IRODORI_PRECISION="bf16")
    runtime = wait_ready(client)["runtime"]
    # bf16 applies to CUDA only; the codec stays fp32 on the model's device.
    assert runtime == {
        "device": "cpu",
        "model_precision": "fp32",
        "codec_device": "cpu",
        "codec_precision": "fp32",
        "compile_model": False,
        "compile_dynamic": False,
    }


FFMPEG = shutil.which("ffmpeg")
needs_ffmpeg = pytest.mark.skipif(FFMPEG is None, reason="ffmpeg is not on PATH")


def test_other_formats_need_ffmpeg(make_client, tmp_path: Path) -> None:
    client, _ = make_client()
    wait_ready(client)
    assert client.get("/system").json()["ffmpeg_available"] is False
    audio_id = _completed(client)["outputs"][0]["audio_id"]
    response = client.post(f"/audio/{audio_id}/save", json={"path": str(tmp_path / "x.mp3")})
    assert (response.status_code, response.json()["code"]) == (400, "ffmpeg_unavailable")
    assert not list(tmp_path.glob("*x*"))  # nothing written, not even a partial file
    # The explicit format decides the extension.
    saved = client.post(
        f"/audio/{audio_id}/save", json={"path": str(tmp_path / "x.mp3"), "format": "wav"}
    )
    assert saved.json()["path"].endswith("x.wav") and saved.json()["format"] == "wav"


@needs_ffmpeg
def test_save_as_compressed_formats(make_client, tmp_path: Path) -> None:
    client, _ = make_client(IRODORI_FFMPEG=FFMPEG)
    wait_ready(client)
    assert client.get("/system").json()["ffmpeg_available"] is True
    audio_id = _completed(client)["outputs"][0]["audio_id"]
    for fmt in ("mp3", "m4a", "flac", "opus"):
        response = client.post(
            f"/audio/{audio_id}/save", json={"path": str(tmp_path / "take"), "format": fmt}
        )
        assert response.status_code == 200, response.text
        written = Path(response.json()["path"])
        assert written.name == f"take.{fmt}" and written.stat().st_size > 0
        if fmt == "m4a":
            assert written.read_bytes()[4:8] == b"ftyp"
        else:
            data, rate = sf.read(str(written))
            assert rate == 48000 and len(data) > 0
    # Without `format`, the extension decides.
    inferred = client.post(f"/audio/{audio_id}/save", json={"path": str(tmp_path / "y.flac")})
    assert inferred.json()["format"] == "flac"


@needs_ffmpeg
def test_reference_clips_in_other_formats(make_client, tmp_path: Path) -> None:
    client, _ = make_client(IRODORI_FFMPEG=FFMPEG)
    source = tmp_path / "ref.wav"
    sf.write(str(source), [0.1, -0.1] * 24000, 48000)
    encoded = tmp_path / "ref.m4a"
    subprocess.run(
        [FFMPEG, "-hide_banner", "-loglevel", "error", "-y", "-i", str(source), str(encoded)],
        check=True,
    )
    upload = client.post("/clips", files={"file": ("ref.m4a", encoded.read_bytes(), "audio/mp4")})
    assert upload.status_code == 201, upload.text
    assert upload.json()["sample_rate"] == 48000
    assert 0.9 < upload.json()["duration_s"] < 1.2
