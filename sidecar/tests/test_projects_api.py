"""Projects (Session 7, D23): a narration or script saved as `.iroproj` reopens as a new
one with its chunks / lines, settings and adopted takes bit for bit; voices the library
lacks are dropped and reported; broken files are refused."""

from __future__ import annotations

import io
import json
import zipfile
from pathlib import Path

import numpy as np
import soundfile as sf
from conftest import read_events, wait_ready

CONSENT = {"statement": "本人の同意を得ています（テスト用の同意文）。", "locale": "ja"}


def _voice(client, name: str) -> str:  # type: ignore[no-untyped-def]
    buffer = io.BytesIO()
    t = np.arange(48000) / 48000
    sf.write(buffer, (0.2 * np.sin(2 * np.pi * 220 * t)).astype(np.float32), 48000, format="WAV")
    clip = client.post(
        "/clips",
        files={"file": ("v.wav", buffer.getvalue(), "audio/wav")},
        data={"origin": "upload"},
    ).json()
    saved = client.post(
        "/voices",
        json={
            "name": name,
            "source": "imported",
            "clip_ids": [clip["clip_id"]],
            "consent": CONSENT,
        },
    ).json()
    read_events(client, saved["encode_job_id"])
    return saved["voice"]["id"]


def _samples(client, audio_id: str) -> np.ndarray:  # type: ignore[no-untyped-def]
    data, _ = sf.read(io.BytesIO(client.get(f"/audio/{audio_id}").content), dtype="int16")
    return data


def test_narration_round_trip(make_client, tmp_path: Path) -> None:
    client, _ = make_client()
    wait_ready(client)
    voice = _voice(client, "語り手")
    settings = {
        "reference": {"kind": "voice", "voice_id": voice},
        "caption": "落ち着いて",
        "params": {"num_steps": 30},
        "pauses": {"sentence_ms": 300, "paragraph_ms": 700},
    }
    narration = client.post(
        "/narrations",
        json={
            "source": "一つ目の文です。二つ目の文です。\n\n三つ目です。",
            "rules": {"min_chars": 5, "max_chars": 40},
            "settings": settings,
        },
    ).json()
    job = client.post(f"/narrations/{narration['id']}/render", json={}).json()["job_id"]
    read_events(client, job)
    redo = client.post(
        f"/narrations/{narration['id']}/render",
        json={"indices": [1], "redo": True, "num_candidates": 2},
    ).json()
    read_events(client, redo["job_id"])
    original = client.get(f"/narrations/{narration['id']}").json()
    second = original["chunks"][1]
    adopted = second["takes"][1]["audio_id"]  # not the first take
    client.patch(f"/narrations/{narration['id']}/chunks/1", json={"adopted_audio_id": adopted})
    original = client.get(f"/narrations/{narration['id']}").json()
    expected = [_samples(client, c["adopted_audio_id"]) for c in original["chunks"]]

    path = tmp_path / "語り.iroproj"
    saved = client.post(
        "/projects/save",
        json={"kind": "narration", "id": narration["id"], "path": str(tmp_path / "語り")},
    )
    assert saved.status_code == 200, saved.text
    assert saved.json()["path"] == str(path)
    with zipfile.ZipFile(path) as archive:
        document = json.loads(archive.read("project.json"))
        assert document["format"] == "iroproj" and document["version"] == 1
        assert document["voices"] == {voice: "語り手"}
        assert sum(name.startswith("audio/") for name in archive.namelist()) == 3  # adopted only

    opened = client.post("/projects/open", json={"path": str(path)})
    assert opened.status_code == 201, opened.text
    assert opened.json()["missing_voices"] == []
    copy = client.get(f"/narrations/{opened.json()['id']}").json()
    assert copy["id"] != narration["id"]
    for key in ("title", "format", "source", "rules", "settings", "warnings"):
        assert copy[key] == original[key], key
    assert [(c["text"], c["pause_after"], c["cue"]) for c in copy["chunks"]] == [
        (c["text"], c["pause_after"], c["cue"]) for c in original["chunks"]
    ]
    assert all(len(c["takes"]) == 1 and c["adopted_audio_id"] for c in copy["chunks"])
    for chunk, samples in zip(copy["chunks"], expected, strict=True):
        assert np.array_equal(_samples(client, chunk["adopted_audio_id"]), samples)
    assert client.post(f"/narrations/{copy['id']}/assemble").status_code == 200

    # Without the voice: the project still opens, without a reference, and says so.
    client.delete(f"/voices/{voice}")
    orphan = client.post("/projects/open", json={"path": str(path)}).json()
    assert orphan["missing_voices"] == ["語り手"]
    lost = client.get(f"/narrations/{orphan['id']}").json()
    assert lost["settings"]["reference"] == {"kind": "none"}


def test_script_round_trip_and_bad_files(make_client, tmp_path: Path) -> None:
    client, _ = make_client()
    wait_ready(client)
    voice = _voice(client, "太郎の声")
    script = client.post(
        "/scripts",
        json={
            "source": "太郎：おはよう。\n花子：おはようございます。\n太郎：いい天気だね。",
            "title": "朝",
            "settings": {"pause_ms": 300, "naming_template": "{n}_{speaker}"},
        },
    ).json()
    client.patch(
        f"/scripts/{script['id']}",
        json={
            "speakers": [{"name": "太郎", "voice_id": voice}, {"name": "花子", "caption": "明るく"}]
        },
    )
    lines = script["lines"]
    client.patch(
        f"/scripts/{script['id']}/lines/{lines[1]['id']}",
        json={"caption": "驚いて", "seed": 7, "pause_ms": 900, "file_name": "hanako"},
    )
    job = client.post(
        f"/scripts/{script['id']}/render", json={"line_ids": [lines[0]["id"], lines[1]["id"]]}
    ).json()
    read_events(client, job["job_id"])
    original = client.get(f"/scripts/{script['id']}").json()

    path = tmp_path / "朝.iroproj"
    client.post("/projects/save", json={"kind": "script", "id": script["id"], "path": str(path)})
    opened = client.post("/projects/open", json={"path": str(path)}).json()
    copy = client.get(f"/scripts/{opened['id']}").json()
    assert (copy["title"], copy["speakers"], copy["settings"]) == (
        original["title"], original["speakers"], original["settings"],
    )  # fmt: skip
    fields = ("speaker", "text", "caption", "num_candidates", "seed", "pause_ms", "file_name")
    assert [[line[f] for f in fields] for line in copy["lines"]] == [
        [line[f] for f in fields] for line in original["lines"]
    ]
    assert [bool(line["adopted_audio_id"]) for line in copy["lines"]] == [True, True, False]
    for mine, theirs in zip(copy["lines"][:2], original["lines"][:2], strict=True):
        assert np.array_equal(
            _samples(client, mine["adopted_audio_id"]), _samples(client, theirs["adopted_audio_id"])
        )

    client.delete(f"/voices/{voice}")
    orphan = client.post("/projects/open", json={"path": str(path)}).json()
    assert orphan["missing_voices"] == ["太郎の声"]
    assert client.get(f"/scripts/{orphan['id']}").json()["speakers"][0]["voice_id"] is None

    junk = tmp_path / "junk.iroproj"
    junk.write_bytes(b"not a zip")
    refused = client.post("/projects/open", json={"path": str(junk)})
    assert (refused.status_code, refused.json()["code"]) == (422, "project_invalid")
    assert refused.json()["detail"]["reason"] == "zip"
    future = tmp_path / "future.iroproj"
    with zipfile.ZipFile(future, "w") as archive:
        archive.writestr(
            "project.json", json.dumps({"format": "iroproj", "version": 99, "kind": "script"})
        )
    newer = client.post("/projects/open", json={"path": str(future)}).json()
    assert newer["code"] == "project_invalid" and newer["detail"]["reason"] == "version"
    traversal = tmp_path / "evil.iroproj"
    document = json.loads(zipfile.ZipFile(path).read("project.json"))
    document["script"]["lines"][0]["take"]["file"] = "../../etc/passwd"
    with zipfile.ZipFile(traversal, "w") as archive:
        archive.writestr("project.json", json.dumps(document))
    evil = client.post("/projects/open", json={"path": str(traversal)}).json()
    assert evil["code"] == "project_invalid"
    missing = client.post(
        "/projects/save", json={"kind": "script", "id": "0" * 26, "path": str(path)}
    )
    assert missing.json()["code"] == "script_not_found"
