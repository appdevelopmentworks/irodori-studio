"""External API (Session 8, D21): the OpenAI-compatible routes (Irodori-TTS-Server shape,
chunking, SSE, speed, the `irodori` extension), the VOICEVOX-compatible routes (speakers
and styles with stable ids, audio_query, synthesis with its scales), API keys, and the
listener's lifecycle on a real port. Fake backend: 0.1 s of noise per candidate."""

from __future__ import annotations

import base64
import io
import json
import shutil
import socket
import zipfile

import httpx
import numpy as np
import pytest
import soundfile as sf
from conftest import read_events, wait_ready
from fastapi.testclient import TestClient

from app.compat.server import create_external_app
from app.schemas import ApiServerConfig

CONSENT = {"statement": "本人の同意を得ています（テスト用の同意文）。", "locale": "ja"}
FFMPEG = shutil.which("ffmpeg")


def _voice(client, name: str, **defaults: object) -> str:  # type: ignore[no-untyped-def]
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
            **defaults,
        },
    ).json()
    read_events(client, saved["encode_job_id"])
    return saved["voice"]["id"]


def _external(client) -> TestClient:  # type: ignore[no-untyped-def]
    services = client.app.state.services
    return TestClient(create_external_app(services, services.api_server))


def _wav(data: bytes) -> tuple[np.ndarray, int]:
    samples, rate = sf.read(io.BytesIO(data), dtype="float32", always_2d=True)
    return samples, rate


def test_openai_speech(make_client) -> None:
    client, backend = make_client()
    wait_ready(client)
    voice = _voice(client, "語り手", caption_default="落ち着いた声。", seed_default=11)
    api = _external(client)

    assert api.get("/v1/models").json()["data"][0]["id"] == "irodori-tts"
    voices = api.get("/v1/audio/voices").json()["data"]
    assert [(v["id"], v["name"]) for v in voices] == [(voice, "語り手")]

    spoken = api.post(
        "/v1/audio/speech",
        json={"model": "irodori-tts", "input": "こんにちは。", "voice": "語り手"},
    )
    assert spoken.status_code == 200, spoken.text
    assert (
        spoken.headers["content-type"] == "audio/wav" and spoken.headers["x-irodori-seed"] == "11"
    )
    samples, rate = _wav(spoken.content)
    assert rate == 48000 and len(samples) == 4800
    sent = backend.requests[-1]
    assert (sent.caption, sent.seed, len(sent.ref_latents)) == ("落ち着いた声。", 11, 1)

    # The extension overrides the voice's defaults; `speed` becomes a shorter duration.
    raw = api.post(
        "/v1/audio/speech",
        json={
            "model": "tts-1",
            "input": "こんにちは。",
            "voice": {"id": voice},
            "response_format": "pcm",
            "speed": 1.25,
            "irodori": {"caption": "明るく。", "num_steps": 12, "seed": 5},
        },
    )
    assert raw.headers["content-type"] == "audio/pcm" and len(raw.content) == 4800 * 2
    sent = backend.requests[-1]
    assert (sent.caption, sent.seed, sent.params["num_steps"]) == ("明るく。", 5, 12)
    assert sent.params["duration_scale"] == pytest.approx(0.8)

    none = api.post(
        "/v1/audio/speech", json={"model": "irodori-tts", "input": "やあ。", "voice": "none"}
    )
    assert none.status_code == 200 and backend.requests[-1].ref_latents == ()
    history = client.get("/history", params={"limit": 3}).json()["items"]
    assert {entry["source"] for entry in history} == {"api"}

    missing = api.post(
        "/v1/audio/speech", json={"model": "irodori-tts", "input": "x", "voice": "誰か"}
    )
    assert missing.status_code == 400
    assert missing.json()["error"]["code"] == "voice_not_found"
    bad_model = api.post("/v1/audio/speech", json={"model": "gpt-9", "input": "x"})
    assert (
        bad_model.status_code == 400
        and bad_model.json()["error"]["type"] == "invalid_request_error"
    )
    bad_params = api.post(
        "/v1/audio/speech",
        json={"model": "irodori-tts", "input": "x", "irodori": {"num_steps": 999}},
    )
    assert bad_params.status_code == 400 and bad_params.json()["error"]["code"] == "invalid_params"
    latent = api.post(
        "/v1/audio/speech",
        json={"model": "irodori-tts", "input": "x", "irodori": {"ref_latent": "a.pt"}},
    )
    assert latent.json()["error"]["code"] == "reference_unsupported"


def test_openai_chunks_and_sse(make_client) -> None:
    client, backend = make_client()
    wait_ready(client)
    api = _external(client)
    text = "一つ目の文です。二つ目の文です。三つ目の文です。"
    whole = api.post(
        "/v1/audio/speech",
        json={"model": "irodori-tts", "input": text, "irodori": {"chunk_min_chars": 5}},
    )
    assert len(_wav(whole.content)[0]) == 3 * 4800  # three chunks, joined
    assert [r.text for r in backend.requests[-3:]] == [
        "一つ目の文です。",
        "二つ目の文です。",
        "三つ目の文です。",
    ]
    single = api.post(
        "/v1/audio/speech",
        json={"model": "irodori-tts", "input": text, "irodori": {"chunking_enabled": False}},
    )
    assert len(_wav(single.content)[0]) == 4800

    with api.stream(
        "POST",
        "/v1/audio/speech",
        json={
            "model": "irodori-tts",
            "input": text,
            "stream_format": "sse",
            "irodori": {"chunk_min_chars": 5, "first_sentence_chunk_min_chars": 3},
        },
    ) as response:
        assert response.headers["content-type"].startswith("text/event-stream")
        body = "".join(response.iter_text())
    events = [block for block in body.split("\n\n") if block.strip()]
    kinds = [block.split("\n")[0].removeprefix("event: ") for block in events]
    assert kinds == ["audio_chunk", "audio_chunk", "audio_chunk", "done"]
    first = json.loads(events[0].split("\n")[1].removeprefix("data: "))
    assert first["index"] == 0 and first["text"] == "一つ目の文です。" and first["format"] == "wav"
    assert len(_wav(base64.b64decode(first["audio_base64"]))[0]) == 4800
    assert json.loads(events[-1].split("\n")[1].removeprefix("data: ")) == {"chunks": 3}


def test_voicevox(make_client) -> None:
    client, backend = make_client()
    wait_ready(client)
    voice = _voice(client, "太郎", caption_default="元気な少年。", seed_default=3)
    api = _external(client)

    speakers = api.get("/speakers").json()
    assert len(speakers) == 1 and speakers[0]["name"] == "太郎"
    styles = speakers[0]["styles"]
    assert styles[0]["name"] == "ノーマル" and len(styles) == 11
    assert all(s["type"] == "talk" and 0 <= s["id"] < 2**31 for s in styles)
    assert api.get("/speakers").json() == speakers  # stable ids
    listed = client.get("/api-server/styles").json()
    assert [s["style_id"] for s in listed] == [s["id"] for s in styles]
    normal, bright = styles[0]["id"], styles[2]["id"]

    query = api.post("/audio_query", params={"text": "こんにちは。", "speaker": normal}).json()
    assert query["kana"] == "こんにちは。" and query["accent_phrases"] == []
    assert query["outputSamplingRate"] == 48000
    spoken = api.post("/synthesis", params={"speaker": normal}, json=query)
    assert spoken.status_code == 200 and spoken.headers["content-type"] == "audio/wav"
    samples, rate = _wav(spoken.content)
    assert rate == 48000 and len(samples) == 4800 + 2 * 4800  # 0.1 s pads before and after
    sent = backend.requests[-1]
    assert (sent.text, sent.caption, sent.seed) == ("こんにちは。", "元気な少年。", 3)

    styled = dict(query, speedScale=1.25, volumeScale=0.5, prePhonemeLength=0,
                  postPhonemeLength=0, outputStereo=True)  # fmt: skip
    louder = api.post("/synthesis", params={"speaker": normal}, json=dict(styled, volumeScale=1.0))
    quieter = api.post("/synthesis", params={"speaker": bright}, json=styled)
    sent = backend.requests[-1]
    assert sent.caption == "明るく元気な声で、楽しそうに話している。"
    assert sent.params["duration_scale"] == pytest.approx(0.8)
    a, b = _wav(louder.content)[0], _wav(quieter.content)[0]
    assert b.shape == (4800, 2) and np.allclose(b[:, 0], b[:, 1])
    assert np.abs(b).max() == pytest.approx(np.abs(a).max() / 2, rel=0.01)  # same seed and noise

    from_moras = dict(
        query, kana="", accent_phrases=[{"moras": [{"text": "コ"}, {"text": "ン"}], "accent": 1}]
    )
    api.post("/synthesis", params={"speaker": normal}, json=from_moras)
    assert backend.requests[-1].text == "コン"
    empty = api.post("/synthesis", params={"speaker": normal}, json=dict(query, kana=""))
    assert empty.status_code == 422
    unknown = api.post("/audio_query", params={"text": "x", "speaker": 123})
    assert unknown.status_code == 422

    bundle = api.post("/multi_synthesis", params={"speaker": normal}, json=[query, query])
    with zipfile.ZipFile(io.BytesIO(bundle.content)) as archive:
        assert archive.namelist() == ["001.wav", "002.wav"]
    joined = api.post("/connect_waves", json=[base64.b64encode(spoken.content).decode()] * 2)
    assert len(_wav(joined.content)[0]) == 2 * len(samples)

    info = api.get("/speaker_info", params={"speaker_uuid": speakers[0]["speaker_uuid"]}).json()
    assert "Irodori-TTS" in info["policy"] and len(info["style_infos"]) == 11
    assert base64.b64decode(info["portrait"])[:8] == b"\x89PNG\r\n\x1a\n"
    by_url = api.get(
        "/speaker_info",
        params={"speaker_uuid": speakers[0]["speaker_uuid"], "resource_format": "url"},
    ).json()
    assert api.get(by_url["portrait"].replace("http://testserver", "")).status_code == 200
    assert api.get("/speaker_info", params={"speaker_uuid": "nobody"}).status_code == 404
    assert api.get("/version").json() == client.app.state.config.app_version
    manifest = api.get("/engine_manifest").json()
    assert (
        manifest["name"] == "irodori-studio"
        and manifest["supported_features"]["adjust_speed_scale"]
    )
    assert api.get("/supported_devices").json() == {"cpu": True, "cuda": False, "dml": False}
    assert api.get("/is_initialized_speaker", params={"speaker": normal}).json() is True
    assert api.post("/initialize_speaker", params={"speaker": normal}).status_code == 204
    assert (api.get("/presets").json(), api.get("/user_dict").json()) == ([], {})
    assert voice


def test_api_key_and_request_log(make_client) -> None:
    client, _ = make_client()
    wait_ready(client)
    manager = client.app.state.services.api_server
    manager._config = ApiServerConfig(api_key="secret-key-123")
    api = _external(client)
    refused = api.get("/v1/models")
    assert refused.status_code == 401 and refused.json()["error"]["code"] == "invalid_api_key"
    assert api.get("/speakers").status_code == 401
    assert (
        api.get("/v1/models", headers={"Authorization": "Bearer secret-key-123"}).status_code == 200
    )
    assert api.get("/speakers", headers={"X-API-Key": "secret-key-123"}).status_code == 200
    assert api.get("/speakers", headers={"X-API-Key": "wrong"}).status_code == 401
    requests = client.get("/api-server/status").json()["requests"]
    assert [(r["path"], r["status"], r["family"]) for r in requests[:2]] == [
        ("/speakers", 401, "voicevox"),
        ("/speakers", 200, "voicevox"),
    ]


def _free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def test_listener_on_a_real_port(make_client) -> None:
    client, _ = make_client()
    wait_ready(client)
    port = _free_port()
    started = client.put("/api-server/config", json={"enabled": True, "port": port})
    assert started.status_code == 200, started.text
    assert started.json()["running"] is True
    assert started.json()["urls"] == [f"http://127.0.0.1:{port}"]
    models = httpx.get(f"http://127.0.0.1:{port}/v1/models", timeout=10)
    assert models.status_code == 200 and models.json()["data"][0]["id"] == "irodori-tts"
    assert client.get("/api-server/config").json()["port"] == port

    lan = client.put("/api-server/config", json={"enabled": True, "bind": "lan", "port": port})
    assert (lan.status_code, lan.json()["code"]) == (422, "api_key_required")
    spaced = client.put("/api-server/config", json={"enabled": True, "api_key": "has a space"})
    assert spaced.status_code == 422

    blocker = socket.socket()
    blocker.bind(("127.0.0.1", 0))
    blocker.listen(1)
    try:
        taken = client.put(
            "/api-server/config", json={"enabled": True, "port": blocker.getsockname()[1]}
        ).json()
        assert taken["running"] is False and taken["error"] == "api_port_in_use"
    finally:
        blocker.close()

    stopped = client.put("/api-server/config", json={"enabled": False, "port": port}).json()
    assert stopped == {"running": False, "error": None, "urls": [], "requests": stopped["requests"]}
    with pytest.raises(httpx.HTTPError):
        httpx.get(f"http://127.0.0.1:{port}/v1/models", timeout=2)


def test_file_paths_only_from_this_computer(make_client) -> None:
    client, _ = make_client()
    wait_ready(client)
    services = client.app.state.services
    body = {"model": "irodori-tts", "input": "こんにちは。", "irodori": {"ref_wav": "missing.wav"}}
    remote = _external(client).post("/v1/audio/speech", json=body)  # client "testclient"
    assert remote.status_code == 403 and remote.json()["error"]["code"] == "path_not_allowed"
    lora = _external(client).post(
        "/v1/audio/speech", json={**body, "irodori": {}, "lora_adapter": "C:/adapters/x"}
    )
    assert lora.status_code == 403
    local = TestClient(
        create_external_app(services, services.api_server), client=("127.0.0.1", 50000)
    )
    missing = local.post("/v1/audio/speech", json=body)
    assert missing.status_code == 400 and missing.json()["error"]["code"] == "clip_not_found"


@pytest.mark.skipif(FFMPEG is None, reason="ffmpeg is not on PATH")
def test_rates_and_stretch_through_ffmpeg(make_client) -> None:
    client, _ = make_client(IRODORI_FFMPEG=FFMPEG)
    wait_ready(client)
    _voice(client, "声")
    api = _external(client)
    style = api.get("/speakers").json()[0]["styles"][0]["id"]
    query = api.post("/audio_query", params={"text": "あ。", "speaker": style}).json()
    query.update(outputSamplingRate=24000, prePhonemeLength=0, postPhonemeLength=0, speedScale=4.0)
    samples, rate = _wav(api.post("/synthesis", params={"speaker": style}, json=query).content)
    # speedScale 4: duration_scale 0.5 (the model's floor) and a 2x time stretch (atempo
    # pads a clip as short as the fake 0.1 s a little, so only "clearly shorter" is checked).
    assert rate == 24000 and len(samples) < 0.7 * 0.1 * 24000
    mp3 = api.post(
        "/v1/audio/speech",
        json={"model": "irodori-tts", "input": "あ。", "response_format": "mp3", "speed": 0.25},
    )
    assert mp3.headers["content-type"] == "audio/mpeg" and mp3.content[:3] in (b"ID3", b"\xff\xfb")
