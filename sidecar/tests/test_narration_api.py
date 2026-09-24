"""Narration (Session 5): split, render on the queue (resume, regenerate, voice lock,
SRT timing), assemble with pauses, export with subtitles; the user dictionary and the
reading preview. Fake backend: every take is 0.1 s of noise."""

from __future__ import annotations

from pathlib import Path

from conftest import generate, read_events, wait_ready

from app.text import srt

MANUSCRIPT = "一つ目の文です。二つ目の文です。\n\n三つ目の段落です。"
RULES = {"min_chars": 5, "max_chars": 40}


def _create(client, **body: object) -> dict:  # type: ignore[no-untyped-def]
    payload = {"source": MANUSCRIPT, "rules": RULES, **body}
    response = client.post("/narrations", json=payload)
    assert response.status_code == 201, response.text
    return response.json()


def _render(client, narration_id: str, **body: object) -> list[tuple[str, dict]]:  # type: ignore[no-untyped-def]
    response = client.post(f"/narrations/{narration_id}/render", json=body)
    assert response.status_code == 200, response.text
    assert response.json() is not None
    return read_events(client, response.json()["job_id"])


def test_split_render_assemble_export(make_client, tmp_path: Path) -> None:
    client, backend = make_client()
    wait_ready(client)
    narration = _create(client, settings={"pauses": {"sentence_ms": 300, "paragraph_ms": 800}})
    assert narration["settings"]["params"] == {}  # nothing given, nothing sent back as null
    chunks = narration["chunks"]
    assert [c["text"] for c in chunks] == [
        "一つ目の文です。",
        "二つ目の文です。",
        "三つ目の段落です。",
    ]
    assert [c["pause_after"] for c in chunks] == ["sentence", "paragraph", "paragraph"]
    assert all(c["estimated_seconds"] > 0 for c in chunks)
    assert narration["title"] == "一つ目の文です。"

    events = _render(client, narration["id"])
    chunk_events = [data for kind, data in events if kind == "chunk"]
    assert [e["index"] for e in chunk_events] == [0, 1, 2]
    progress = [data for kind, data in events if kind == "progress" and data["unit"] == "chunk"]
    assert progress[-1] == {"done": 3, "total": 3, "unit": "chunk"}
    assert events[-1] == ("completed", {"narration_id": narration["id"], "rendered": 3})
    assert [r.text for r in backend.requests] == [c["text"] for c in chunks]

    narration = client.get(f"/narrations/{narration['id']}").json()
    assert all(c["adopted_audio_id"] == c["takes"][0]["audio_id"] for c in narration["chunks"])
    take = narration["chunks"][0]["takes"][0]
    assert take["duration_s"] == 0.1 and take["truncated"] is False
    assert client.get(f"/audio/{take['audio_id']}").status_code == 200
    assert client.post(f"/narrations/{narration['id']}/render", json={}).json() is None

    assembled = client.post(f"/narrations/{narration['id']}/assemble").json()
    cues = assembled["cues"]
    # 0.1 s takes: sentence pause 300 ms after chunk 1, paragraph pause 800 ms after chunk 2.
    assert [(c["start_ms"], c["end_ms"]) for c in cues] == [(0, 100), (400, 500), (1300, 1400)]
    assert assembled["duration_s"] == 1.4
    assert client.get(f"/audio/{assembled['audio_id']}").status_code == 200

    dest = tmp_path / "story"
    exported = client.post(
        f"/narrations/{narration['id']}/export",
        json={"path": str(dest), "subtitles": ["srt", "vtt"], "per_chunk": True},
    )
    assert exported.status_code == 200, exported.text
    names = [Path(f["path"]).name for f in exported.json()["files"]]
    assert names == [
        "story.wav", "story.srt", "story.vtt", "story_001.wav", "story_002.wav", "story_003.wav"
    ]  # fmt: skip
    written = srt.parse((tmp_path / "story.srt").read_text(encoding="utf-8"))
    assert [(c.start_ms, c.end_ms, c.text) for c in written] == [
        (c["start_ms"], c["end_ms"], c["text"]) for c in cues
    ]


def test_regenerate_edit_and_adopt(make_client) -> None:
    client, _ = make_client()
    wait_ready(client)
    narration = _create(client)
    _render(client, narration["id"])
    events = _render(client, narration["id"], indices=[1], redo=True, num_candidates=2)
    chunk = next(data for kind, data in events if kind == "chunk")
    assert chunk["index"] == 1 and len(chunk["takes"]) == 2

    current = client.get(f"/narrations/{narration['id']}").json()["chunks"][1]
    assert len(current["takes"]) == 3
    assert current["adopted_audio_id"] == chunk["takes"][0]["audio_id"]
    first = current["takes"][0]["audio_id"]
    adopted = client.patch(
        f"/narrations/{narration['id']}/chunks/1", json={"adopted_audio_id": first}
    )
    assert adopted.json()["chunks"][1]["adopted_audio_id"] == first
    stranger = client.patch(
        f"/narrations/{narration['id']}/chunks/1", json={"adopted_audio_id": "0" * 26}
    )
    assert (stranger.status_code, stranger.json()["code"]) == (404, "audio_not_found")

    client.post(f"/narrations/{narration['id']}/assemble")
    edited = client.patch(
        f"/narrations/{narration['id']}/chunks/1", json={"text": "書き直した文です。"}
    ).json()
    assert edited["chunks"][1]["text"] == "書き直した文です。"
    assert edited["chunks"][1]["takes"] == [] and edited["chunks"][1]["adopted_audio_id"] is None
    assert edited["assembled"] is None
    missing = client.post(f"/narrations/{narration['id']}/assemble")
    assert (missing.status_code, missing.json()["code"]) == (409, "narration_incomplete")
    assert missing.json()["detail"] == {"missing": [1]}
    assert client.get(f"/audio/{first}").status_code == 404  # takes of the old text are gone


def test_cancel_and_resume(make_client) -> None:
    client, backend = make_client()
    wait_ready(client)
    narration = _create(client)
    backend.blocking = True
    job_id = client.post(f"/narrations/{narration['id']}/render", json={}).json()["job_id"]
    assert backend.started.wait(5)
    busy = client.post(f"/narrations/{narration['id']}/split", json={"source": "別の原稿。"})
    assert (busy.status_code, busy.json()["code"]) == (409, "narration_busy")
    assert client.post(f"/jobs/{job_id}/cancel").json()["state"] == "cancelling"
    assert read_events(client, job_id)[-1][0] == "cancelled"

    backend.blocking = False
    done = client.get(f"/narrations/{narration['id']}").json()
    assert all(c["adopted_audio_id"] is None for c in done["chunks"])  # chunk 1 was cut short
    events = _render(client, narration["id"])
    assert events[-1][1]["rendered"] == 3
    assert client.get(f"/jobs/{job_id}").json()["state"] == "cancelled"


def test_voice_lock_uses_chunk_one(make_client) -> None:
    client, backend = make_client()
    wait_ready(client)
    narration = _create(client, settings={"caption": "落ち着いた声。", "voice_lock": True})
    _render(client, narration["id"], indices=[2])  # chunk 1 comes first for the lock
    assert [r.text for r in backend.requests] == ["一つ目の文です。", "三つ目の段落です。"]
    assert backend.requests[0].ref_latents == ()
    assert len(backend.requests[1].ref_latents) == 1
    assert all(r.caption == "落ち着いた声。" for r in backend.requests)

    unlocked = _create(client, settings={"voice_lock": False})
    backend.requests.clear()
    _render(client, unlocked["id"])
    assert all(r.ref_latents == () for r in backend.requests)


def test_srt_input_fits_cues(make_client) -> None:
    client, backend = make_client()
    wait_ready(client)
    source = (
        "1\n00:00:01,000 --> 00:00:03,000\n最初の字幕。\n\n"
        "2\n00:00:05,500 --> 00:00:06,700\n二つ目。\n\n"
        "3\n00:00:06,500 --> 00:00:45,000\n長すぎる字幕。\n"
    )
    narration = _create(client, source=source, format="srt")
    assert [c["pause_after"] for c in narration["chunks"]] == ["cue"] * 3
    assert narration["chunks"][0]["cue"] == {"start_ms": 1000, "end_ms": 3000}
    assert {(w["code"], w["index"]) for w in narration["warnings"]} == {
        ("cue_overlap", 2),
        ("cue_too_long", 2),
    }
    _render(client, narration["id"])
    assert [r.params["seconds"] for r in backend.requests] == [2.0, 1.2, 30.0]
    cues = client.post(f"/narrations/{narration['id']}/assemble").json()["cues"]
    # Placed at their own cue times (the 0.1 s takes never run into the next cue).
    assert [(c["start_ms"], c["end_ms"]) for c in cues] == [
        (1000, 3000),
        (5500, 6700),
        (6500, 45000),
    ]
    bad = client.post("/narrations", json={"source": "字幕ではない", "format": "srt"})
    assert (bad.status_code, bad.json()["code"]) == (422, "subtitle_invalid")


def test_dictionary_reading_and_generation(make_client) -> None:
    client, backend = make_client()
    wait_ready(client)
    saved = client.put(
        "/dictionary",
        json=[
            {"surface": "明日", "reading": "アシタ", "note": "口語"},
            {"surface": "今日", "reading": "キョウ", "enabled": False},
        ],
    )
    assert saved.status_code == 200, saved.text
    assert [e["surface"] for e in client.get("/dictionary").json()] == ["明日", "今日"]
    invalid = client.put("/dictionary", json=[{"surface": "明日", "reading": ""}])
    assert invalid.status_code == 422

    reading = client.post("/text/reading", json={"text": "明日は晴れ。"}).json()
    assert reading["tokens"][0] == {
        "surface": "明日",
        "reading": "アシタ",
        "moras": 3 if reading["analyzer"] else 0,
        "source": "dictionary",
    }
    assert reading["estimated_seconds"] > 0

    job_id = generate(client, text="明日と今日")
    assert read_events(client, job_id)[-1][0] == "completed"
    assert backend.requests[-1].text == "アシタと今日"
    entry_id = client.get("/history").json()["items"][0]["id"]
    entry = client.get(f"/history/{entry_id}").json()
    assert entry["text"] == "明日と今日"  # as submitted
    assert any("dictionary" in message for message in entry["messages"])
    job_id = generate(client, text="明日と今日", apply_dictionary=False)
    read_events(client, job_id)
    assert backend.requests[-1].text == "明日と今日"


def test_job_info_for_every_kind(make_client) -> None:
    client, _ = make_client()
    wait_ready(client)
    narration = _create(client)
    job_id = client.post(f"/narrations/{narration['id']}/render", json={}).json()["job_id"]
    read_events(client, job_id)
    info = client.get(f"/jobs/{job_id}")
    assert info.status_code == 200, info.text
    assert info.json()["kind"] == "narration"
    assert info.json()["result"] == {"narration_id": narration["id"], "rendered": 3}

    clip = client.post(
        "/clips", files={"file": ("a.wav", _wav(), "audio/wav")}, data={"origin": "recording"}
    ).json()
    saved = client.post(
        "/voices",
        json={
            "name": "v",
            "source": "recorded",
            "clip_ids": [clip["clip_id"]],
            "consent": {"statement": "本人の同意を得ています（テスト）。", "locale": "ja"},
        },
    ).json()
    read_events(client, saved["encode_job_id"])
    encode = client.get(f"/jobs/{saved['encode_job_id']}")
    assert encode.status_code == 200, encode.text
    assert encode.json()["result"] == {"voice_id": saved["voice"]["id"], "encoded": 1}


def test_history_pruning_keeps_narration_audio(make_client) -> None:
    client, _ = make_client()
    wait_ready(client)
    client.patch("/preferences", json={"history_max_entries": 1})
    narration = _create(client)
    _render(client, narration["id"])
    for _ in range(3):
        read_events(client, generate(client))
    assert client.get("/history").json()["total"] == 1
    for chunk in client.get(f"/narrations/{narration['id']}").json()["chunks"]:
        assert client.get(f"/audio/{chunk['adopted_audio_id']}").status_code == 200

    listed = client.get("/narrations").json()
    assert listed[0]["id"] == narration["id"] and listed[0]["rendered"] == 3
    assert client.delete(f"/narrations/{narration['id']}").status_code == 204
    assert client.get(f"/narrations/{narration['id']}").status_code == 404


def _wav() -> bytes:
    import io

    import numpy as np
    import soundfile as sf

    buffer = io.BytesIO()
    t = np.arange(48000) / 48000
    sf.write(buffer, (0.2 * np.sin(2 * np.pi * 220 * t)).astype(np.float32), 48000, format="WAV")
    return buffer.getvalue()
