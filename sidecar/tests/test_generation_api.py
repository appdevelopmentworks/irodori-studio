"""Generation API end to end with a fake backend: jobs, SSE, queue, cancel, watermark
policy, reference clips, history and the engine state (no torch needed)."""

from __future__ import annotations

import io
import time

import numpy as np
import soundfile as sf
from conftest import FakeBackend, generate, read_events, wait_ready

from app.engine.params import MAX_SEED


def _types(events: list[tuple[str, dict]]) -> list[str]:
    return [kind for kind, _ in events]


def _wav_bytes(seconds: float = 1.0, rate: int = 48000) -> bytes:
    t = np.arange(int(seconds * rate)) / rate
    buffer = io.BytesIO()
    sf.write(buffer, (0.2 * np.sin(2 * np.pi * 220 * t)).astype(np.float32), rate, format="WAV")
    return buffer.getvalue()


def test_generate_streams_events_and_stores_history(make_client) -> None:
    client, backend = make_client()
    wait_ready(client)
    job_id = generate(client, params={"num_candidates": 4, "seed": 1234, "num_steps": 8})
    events = read_events(client, job_id)
    kinds = _types(events)
    assert kinds[0] == "queued" and kinds[1] == "started"
    assert kinds[-5:] == ["candidate"] * 4 + ["completed"]
    progress = [data for kind, data in events if kind == "progress"]
    assert progress[0] == {"done": 0, "total": 8, "unit": "step"}
    assert progress[-1] == {"done": 8, "total": 8, "unit": "step"}
    assert ("log", {"line": "fake: synthesized"}) in events

    completed = events[-1][1]
    assert completed["used_seed"] == 1234
    assert completed["watermarked"] is True
    assert {"sample_rf", "silentcipher_watermark", "write_audio"} <= set(completed["timings"])
    assert [o["index"] for o in completed["outputs"]] == [0, 1, 2, 3]

    audio = client.get(f"/audio/{completed['outputs'][0]['audio_id']}")
    assert audio.status_code == 200 and audio.headers["content-type"] == "audio/wav"
    data, rate = sf.read(io.BytesIO(audio.content))
    assert rate == 48000 and len(data) == 4800

    entry = client.get(f"/history/{completed['history_id']}").json()
    assert entry["used_seed"] == 1234
    assert entry["request"]["params"] == {"num_candidates": 4, "seed": 1234, "num_steps": 8}
    assert entry["params"]["cfg_scale_caption"] == 4.0  # defaults are recorded too
    assert len(entry["outputs"]) == 4

    info = client.get(f"/jobs/{job_id}").json()
    assert info["state"] == "completed" and info["result"]["history_id"] == entry["id"]
    # The request reached the backend fully resolved.
    sent = backend.requests[-1]
    assert sent.seed == 1234 and sent.params["num_steps"] == 8 and "seed" not in sent.params


def test_same_seed_same_audio_and_random_seeds_are_js_safe(make_client) -> None:
    client, _ = make_client()
    wait_ready(client)
    outputs = []
    for _ in range(2):
        completed = read_events(client, generate(client, params={"seed": 42}))[-1][1]
        outputs.append(client.get(f"/audio/{completed['outputs'][0]['audio_id']}").content)
    assert outputs[0] == outputs[1]

    completed = read_events(client, generate(client))[-1][1]
    assert 0 <= completed["used_seed"] <= MAX_SEED


def test_watermark_toggle(make_client) -> None:
    client, backend = make_client()
    wait_ready(client)
    assert client.get("/preferences").json()["watermark_enabled"] is True
    assert client.patch("/preferences", json={"watermark_enabled": False}).status_code == 200
    completed = read_events(client, generate(client))[-1][1]
    assert backend.requests[-1].watermark is False
    assert completed["watermarked"] is False
    assert "silentcipher_watermark" not in completed["timings"]
    # Persisted in the database, not in memory only.
    assert client.get("/preferences").json()["watermark_enabled"] is False


def test_watermark_never_lapses_silently(make_client) -> None:
    client, _ = make_client(FakeBackend(watermark_ready=False))
    wait_ready(client)
    assert "watermark_unavailable" in client.get("/system").json()["issues"]
    events = read_events(client, generate(client))
    assert events[-1] == (
        "failed",
        {"code": "watermark_unavailable", "message": "watermarker not loaded"},
    )
    client.patch("/preferences", json={"watermark_enabled": False})
    assert read_events(client, generate(client))[-1][0] == "completed"


def test_cancel_queued_and_running_jobs(make_client) -> None:
    client, backend = make_client()
    wait_ready(client)
    backend.blocking = True
    running = generate(client)
    assert backend.started.wait(5)
    queued = generate(client)
    assert client.get(f"/jobs/{queued}").json()["queue_position"] == 1
    snapshot = client.get("/queue").json()
    assert snapshot["running"]["job_id"] == running
    assert [item["job_id"] for item in snapshot["queued"]] == [queued]

    assert client.post(f"/jobs/{queued}/cancel").json()["state"] == "cancelled"
    assert _types(read_events(client, queued)) == ["queued", "cancelled"]

    assert client.post(f"/jobs/{running}/cancel").json()["state"] == "cancelling"
    assert read_events(client, running)[-1][0] == "cancelled"
    assert client.post(f"/jobs/{running}/cancel").json()["state"] == "cancelled"
    assert client.get("/queue").json() == {"running": None, "queued": []}


def test_queue_positions_advance(make_client) -> None:
    client, backend = make_client()
    wait_ready(client)
    backend.blocking = True
    first = generate(client)
    assert backend.started.wait(5)
    second, third = generate(client), generate(client)
    assert client.get(f"/jobs/{third}").json()["queue_position"] == 2
    backend.release.set()
    third_events = read_events(client, third)
    positions = [data["position"] for kind, data in third_events if kind == "queued"]
    assert positions == [2, 1, 0]
    assert third_events[-1][0] == "completed"
    assert read_events(client, first)[-1][0] == "completed"
    assert read_events(client, second)[-1][0] == "completed"


def test_sse_resumes_after_last_event_id(make_client) -> None:
    client, _ = make_client()
    wait_ready(client)
    job_id = generate(client, params={"num_steps": 2})
    events = read_events(client, job_id)
    resumed = read_events(client, job_id, **{"Last-Event-ID": str(len(events) - 1)})
    assert resumed == events[-1:]


def test_request_validation(make_client) -> None:
    client, _ = make_client()

    def error(body: dict) -> tuple[int, dict]:
        response = client.post("/tts/generate", json=body)
        return response.status_code, response.json()

    status, body = error({"text": "   "})
    assert (status, body["code"]) == (422, "text_empty")
    status, body = error({"text": "あ", "params": {"num_steps": 0}})
    assert (status, body["code"]) == (422, "invalid_params")
    assert body["detail"] == {"param": "num_steps", "reason": "below_minimum"}
    status, body = error({"text": "あ", "params": {"bogus": 1}})
    assert (status, body["code"]) == (422, "invalid_request")
    status, body = error({"text": "あ", "reference": {"kind": "voice", "voice_id": "x"}})
    assert (status, body["code"]) == (404, "voice_not_found")
    missing_clip = {"kind": "clips", "clip_ids": ["01J0000000000000000000000A"]}
    status, body = error({"text": "あ", "reference": missing_clip})
    assert (status, body["code"]) == (404, "clip_not_found")
    status, body = error({"text": "あ", "reference": {"kind": "embedding", "path": "rel.st"}})
    assert (status, body["code"]) == (400, "embedding_not_found")
    status, body = error({"text": "あ", "lora_adapter": "/nowhere"})
    assert (status, body["code"]) == (400, "lora_not_found")
    status, body = error({"text": "あ" * 2001})
    assert (status, body["code"]) == (422, "text_too_long")
    assert client.get("/jobs/01J0000000000000000000000A").json()["code"] == "job_not_found"
    assert client.get("/audio/nope").status_code == 404


def test_reference_clips_are_encoded_once(make_client) -> None:
    client, backend = make_client()
    wait_ready(client)
    upload = client.post("/clips", files={"file": ("ref.wav", _wav_bytes(), "audio/wav")})
    assert upload.status_code == 201, upload.text
    clip = upload.json()
    assert clip["duration_s"] == 1.0 and clip["sample_rate"] == 48000
    reference = {"kind": "clips", "clip_ids": [clip["clip_id"]]}

    first = read_events(client, generate(client, reference=reference, caption="落ち着いた声"))
    assert first[-1][0] == "completed"
    assert "encode_reference" in first[-1][1]["timings"]
    assert len(backend.encoded) == 1
    sent = backend.requests[-1]
    assert len(sent.ref_latents) == 1 and sent.caption == "落ち着いた声"

    read_events(client, generate(client, reference=reference))
    assert len(backend.encoded) == 1  # cached latent reused
    read_events(client, generate(client, reference=reference, params={"ref_normalize_db": None}))
    assert len(backend.encoded) == 2  # different preprocessing -> new latent

    assert client.delete(f"/clips/{clip['clip_id']}").status_code == 204
    assert client.get(f"/clips/{clip['clip_id']}").status_code == 404


def test_clip_upload_errors(make_client) -> None:
    client, _ = make_client()
    bad = client.post("/clips", files={"file": ("x.m4a", b"not audio at all", "audio/mp4")})
    assert (bad.status_code, bad.json()["code"]) == (415, "clip_format_unsupported")
    empty = client.post("/clips", files={"file": ("x.wav", b"", "audio/wav")})
    assert (empty.status_code, empty.json()["code"]) == (422, "clip_empty")


def test_history_list_delete_and_prune(make_client) -> None:
    client, _ = make_client()
    wait_ready(client)
    ids = []
    for text in ("一つ目。", "二つ目。", "三つ目。"):
        ids.append(read_events(client, generate(client, text=text))[-1][1]["history_id"])
    page = client.get("/history", params={"limit": 2}).json()
    assert page["total"] == 3 and [item["id"] for item in page["items"]] == ids[:0:-1]
    assert client.get("/history", params={"q": "二つ"}).json()["total"] == 1

    audio_id = client.get(f"/history/{ids[0]}").json()["outputs"][0]["audio_id"]
    assert client.delete(f"/history/{ids[0]}").status_code == 204
    assert client.get(f"/audio/{audio_id}").status_code == 404
    assert client.delete(f"/history/{ids[0]}").status_code == 404

    client.patch("/preferences", json={"history_max_entries": 1})
    assert client.get("/history").json()["total"] == 1
    assert client.get("/history").json()["items"][0]["id"] == ids[2]


def test_models_capabilities_and_emoji(make_client) -> None:
    client, _ = make_client()
    models = client.get("/models").json()
    assert len(models) == 1 and models[0]["active"] and models[0]["installed"]
    caps = client.get("/models/active/capabilities").json()
    assert caps["model_id"] == models[0]["id"]
    by_name = {p["name"]: p for p in caps["params"]}
    assert by_name["cfg_scale_caption"]["default"] == 4.0
    assert by_name["num_candidates"]["max"] == caps["limits"]["max_candidates"] == 32
    emoji = client.get("/emoji").json()
    assert len(emoji) == 45
    assert len({item["key"] for item in emoji}) == 45
    first = emoji[0]
    assert first["symbol"] == "👂" and first["key"] == "u1f442" and first["label_ja"]


def test_engine_loading_then_ready(make_client) -> None:
    backend = FakeBackend(hold_load=True)
    client, _ = make_client(backend)
    assert client.get("/health").json()["engine"]["state"] == "loading"
    job_id = generate(client)  # accepted while loading; waits in the queue
    time.sleep(0.2)
    assert client.get(f"/jobs/{job_id}").json()["state"] == "queued"
    backend.load_gate.set()
    assert wait_ready(client)["state"] == "ready"
    assert read_events(client, job_id)[-1][0] == "completed"
    system = client.get("/system").json()
    assert system["active_model"] == "irodori-v4.1-small"
    assert system["watermark_available"] is True


def test_engine_load_failure_fails_jobs(make_client) -> None:
    client, _ = make_client(FakeBackend(fail_load="model_files_missing"))
    engine = wait_ready(client)
    assert (engine["state"], engine["model_id"], engine["error_code"]) == (
        "error",
        "irodori-v4.1-small",
        "model_files_missing",
    )
    assert "model_load_failed" in client.get("/system").json()["issues"]
    events = read_events(client, generate(client))
    assert events[-1][0] == "failed" and events[-1][1]["code"] == "model_files_missing"
