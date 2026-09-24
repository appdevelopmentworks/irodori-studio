"""Voice library (Session 4): sources, consent (D13), clip edits, encode on save, voice
references in generation, and `.irovoice` packages (D22). Fake backend, no torch."""

from __future__ import annotations

import io
import json
import zipfile
from pathlib import Path

import numpy as np
import soundfile as sf
from conftest import generate, read_events, wait_ready
from safetensors.numpy import save_file

CONSENT = {"statement": "本人の同意を得ています（テスト用の同意文）。", "locale": "ja"}


def _wav(seconds: float = 1.0, rate: int = 48000) -> bytes:
    t = np.arange(int(seconds * rate)) / rate
    buffer = io.BytesIO()
    sf.write(buffer, (0.2 * np.sin(2 * np.pi * 220 * t)).astype(np.float32), rate, format="WAV")
    return buffer.getvalue()


def _clip(client, seconds: float = 1.0, origin: str = "upload") -> str:  # type: ignore[no-untyped-def]
    response = client.post(
        "/clips",
        files={"file": ("take.wav", _wav(seconds), "audio/wav")},
        data={"origin": origin},
    )
    assert response.status_code == 201, response.text
    assert response.json()["origin"] == origin
    return response.json()["clip_id"]


def _embedding(path: Path, tokens: int = 4, dim: int = 768) -> Path:
    save_file({"speaker_embedding": np.zeros((tokens, dim), dtype=np.float32)}, str(path))
    return path


def _finish(client, saved: dict) -> dict:  # type: ignore[no-untyped-def]
    """Wait for the voice's encode job (if any) and return the fresh voice."""
    if saved.get("encode_job_id"):
        events = read_events(client, saved["encode_job_id"])
        assert events[-1][0] == "completed", events[-1]
    return client.get(f"/voices/{saved['voice']['id']}").json()


def test_imported_voice_needs_consent_and_is_encoded_on_save(make_client) -> None:
    client, backend = make_client()
    wait_ready(client)
    clips = [_clip(client, 1.0), _clip(client, 2.0)]
    body = {"name": "テスト話者", "source": "imported", "clip_ids": clips}

    refused = client.post("/voices", json=body)
    assert (refused.status_code, refused.json()["code"]) == (422, "consent_required")

    saved = client.post("/voices", json={**body, "consent": CONSENT})
    assert saved.status_code == 201, saved.text
    voice = saved.json()["voice"]
    assert [c["clip_id"] for c in voice["clips"]] == clips
    assert voice["consent_required"] is True and voice["total_seconds"] == 3.0
    assert voice["consent"]["statement"] == CONSENT["statement"]
    assert voice["consent"]["confirmed_at"] and voice["consent"]["locale"] == "ja"

    events = read_events(client, saved.json()["encode_job_id"])
    progress = [data for kind, data in events if kind == "progress"]
    assert progress == [
        {"done": 1, "total": 2, "unit": "clip"},
        {"done": 2, "total": 2, "unit": "clip"},
    ]
    assert events[-1][1] == {"voice_id": voice["id"], "encoded": 2}
    assert client.get(f"/voices/{voice['id']}").json()["encoded"] is True
    assert len(backend.encoded) == 2
    assert client.post(f"/voices/{voice['id']}/encode").json() is None  # cached already


def test_generation_with_a_saved_voice_skips_encoding(make_client) -> None:
    client, backend = make_client()
    wait_ready(client)
    saved = client.post(
        "/voices",
        json={
            "name": "v",
            "source": "recorded",
            "clip_ids": [_clip(client, origin="recording")],
            "consent": CONSENT,
        },
    ).json()
    voice = _finish(client, saved)
    for _ in range(2):
        events = read_events(
            client, generate(client, reference={"kind": "voice", "voice_id": voice["id"]})
        )
        assert events[-1][0] == "completed"
        assert "encode_reference" not in events[-1][1]["timings"]
    assert len(backend.encoded) == 1  # only the save encoded
    assert len(backend.requests[-1].ref_latents) == 1

    missing = client.post(
        "/tts/generate",
        json={
            "text": "あ",
            "reference": {"kind": "voice", "voice_id": "01J0000000000000000000000A"},
        },
    )
    assert (missing.status_code, missing.json()["code"]) == (404, "voice_not_found")


def test_designed_voices(make_client) -> None:
    client, backend = make_client()
    wait_ready(client)
    # From an adopted candidate: its audio becomes the voice's reference clip.
    result = read_events(client, generate(client, caption="落ち着いた声"))[-1][1]
    saved = client.post(
        "/voices",
        json={
            "name": "設計した声",
            "source": "designed",
            "from_audio_id": result["outputs"][0]["audio_id"],
            "design_caption": "落ち着いた声",
        },
    )
    assert saved.status_code == 201, saved.text
    voice = _finish(client, saved.json())
    assert [c["origin"] for c in voice["clips"]] == ["generated"]
    assert voice["consent_required"] is False and voice["design_caption"] == "落ち着いた声"

    # Caption-only: no clips; generations with it carry no reference.
    caption_only = client.post(
        "/voices",
        json={"name": "c", "source": "designed", "caption_default": "明るい声", "seed_default": 7},
    ).json()
    assert caption_only["encode_job_id"] is None
    read_events(
        client,
        generate(client, reference={"kind": "voice", "voice_id": caption_only["voice"]["id"]}),
    )
    assert backend.requests[-1].ref_latents == () and backend.requests[-1].ref_embed is None

    empty = client.post("/voices", json={"name": "x", "source": "designed"})
    assert (empty.status_code, empty.json()["code"]) == (400, "voice_invalid")

    # Adding real-voice audio to a designed voice needs consent.
    voice_id = caption_only["voice"]["id"]
    recording = _clip(client, origin="recording")
    refused = client.patch(f"/voices/{voice_id}", json={"clip_ids": [recording]})
    assert refused.json()["code"] == "consent_required"
    accepted = client.patch(
        f"/voices/{voice_id}", json={"clip_ids": [recording], "consent": CONSENT}
    )
    assert accepted.status_code == 200 and accepted.json()["voice"]["consent_required"] is True


def test_embedding_voices(make_client, tmp_path: Path) -> None:
    client, backend = make_client()
    wait_ready(client)
    good = _embedding(tmp_path / "speaker.safetensors")
    saved = client.post(
        "/voices", json={"name": "e", "source": "embedding", "embedding_path": str(good)}
    )
    assert saved.status_code == 201, saved.text
    voice = saved.json()["voice"]
    assert voice["embedding"]["tokens"] == 4 and voice["embedding"]["dim"] == 768
    read_events(client, generate(client, reference={"kind": "voice", "voice_id": voice["id"]}))
    assert str(backend.requests[-1].ref_embed).endswith("voice.speaker.safetensors")

    wrong_dim = _embedding(tmp_path / "small.safetensors", dim=512)
    response = client.post(
        "/voices", json={"name": "e", "source": "embedding", "embedding_path": str(wrong_dim)}
    )
    assert response.json()["code"] == "embedding_invalid"
    assert response.json()["detail"]["reason"] == "dim"
    junk = tmp_path / "junk.speaker.safetensors"
    junk.write_bytes(b"not a safetensors file")
    response = client.post(
        "/voices", json={"name": "e", "source": "embedding", "embedding_path": str(junk)}
    )
    assert response.json()["code"] == "embedding_invalid"

    # Ad-hoc embeddings with any file name work (upstream needs the suffix).
    read_events(client, generate(client, reference={"kind": "embedding", "path": str(good)}))
    assert str(backend.requests[-1].ref_embed).endswith(".speaker.safetensors")


def test_clip_edits_follow_the_voice(make_client) -> None:
    client, _ = make_client()
    wait_ready(client)
    first, second = _clip(client, 2.0), _clip(client, 1.0)
    saved = client.post(
        "/voices",
        json={"name": "v", "source": "imported", "clip_ids": [first, second], "consent": CONSENT},
    ).json()
    voice_id = saved["voice"]["id"]
    _finish(client, saved)

    trimmed = client.post(f"/clips/{first}/trim", json={"start_s": 0.2, "end_s": 1.2})
    assert trimmed.status_code == 200, trimmed.text
    assert trimmed.json()["duration_s"] == 1.0 and trimmed.json()["voice_id"] == voice_id
    assert client.get(f"/clips/{first}").status_code == 404
    voice = client.get(f"/voices/{voice_id}").json()
    assert [c["clip_id"] for c in voice["clips"]] == [trimmed.json()["clip_id"], second]
    assert voice["encoded"] is False  # the new audio has no latent yet

    pieces = client.post(f"/clips/{second}/split", json={"at_s": [0.5]})
    assert [p["duration_s"] for p in pieces.json()] == [0.5, 0.5]
    voice = client.get(f"/voices/{voice_id}").json()
    assert len(voice["clips"]) == 3

    bad = client.post(
        f"/clips/{pieces.json()[0]['clip_id']}/trim", json={"start_s": 0.3, "end_s": 0.35}
    )
    assert bad.json()["code"] == "clip_too_short"
    outside = client.post(f"/clips/{pieces.json()[0]['clip_id']}/split", json={"at_s": [3.0]})
    assert outside.json()["code"] == "clip_range_invalid"
    owned = client.delete(f"/clips/{pieces.json()[0]['clip_id']}")
    assert (owned.status_code, owned.json()["code"]) == (409, "clip_in_use")

    preview = client.get(f"/clips/{pieces.json()[0]['clip_id']}/audio")
    assert preview.headers["content-type"] == "audio/wav"
    assert sf.info(io.BytesIO(preview.content)).subtype == "PCM_16"

    # Dropping clips from the voice deletes them; deleting the voice deletes the rest.
    keep = [c["clip_id"] for c in voice["clips"]][:1]
    dropped = [c["clip_id"] for c in voice["clips"]][1:]
    client.patch(f"/voices/{voice_id}", json={"clip_ids": keep})
    assert all(client.get(f"/clips/{c}").status_code == 404 for c in dropped)
    assert client.delete(f"/voices/{voice_id}").status_code == 204
    assert client.get(f"/clips/{keep[0]}").status_code == 404
    assert client.get(f"/voices/{voice_id}").status_code == 404

    other = client.post(
        "/voices",
        json={"name": "w", "source": "imported", "clip_ids": [_clip(client)], "consent": CONSENT},
    ).json()
    stolen = client.post(
        "/voices",
        json={
            "name": "x",
            "source": "imported",
            "clip_ids": [other["voice"]["clips"][0]["clip_id"]],
            "consent": CONSENT,
        },
    )
    assert (stolen.status_code, stolen.json()["code"]) == (409, "clip_in_use")


def test_defaults_are_validated_and_updated(make_client) -> None:
    client, _ = make_client()
    wait_ready(client)
    bad = client.post(
        "/voices",
        json={
            "name": "d",
            "source": "designed",
            "caption_default": "c",
            "params_default": {"num_steps": 0},
        },
    )
    assert (bad.status_code, bad.json()["code"]) == (422, "invalid_params")
    saved = client.post(
        "/voices",
        json={
            "name": "d",
            "source": "designed",
            "caption_default": "c",
            "params_default": {"num_steps": 20},
        },
    ).json()
    voice_id = saved["voice"]["id"]
    assert saved["voice"]["params_default"] == {"num_steps": 20}
    patched = client.patch(
        f"/voices/{voice_id}",
        json={"name": "新しい名前", "caption_default": None, "test_text": "テストです。"},
    ).json()["voice"]
    assert patched["name"] == "新しい名前" and patched["caption_default"] is None
    assert patched["test_text"] == "テストです。" and patched["params_default"] == {"num_steps": 20}
    assert [v["id"] for v in client.get("/voices").json()] == [voice_id]


def test_packages_round_trip_with_consent(make_client, tmp_path: Path) -> None:
    client, _ = make_client()
    wait_ready(client)
    saved = client.post(
        "/voices",
        json={
            "name": "パッケージ",
            "source": "recorded",
            "clip_ids": [_clip(client, 1.0, "recording"), _clip(client, 1.5, "recording")],
            "consent": CONSENT,
            "caption_default": "やさしく",
            "params_default": {"num_steps": 24},
            "seed_default": 42,
        },
    ).json()
    original = _finish(client, saved)
    exported = client.get(f"/voices/{original['id']}/export")
    assert exported.headers["content-type"] == "application/zip"
    archive = zipfile.ZipFile(io.BytesIO(exported.content))
    manifest = json.loads(archive.read("voice.json"))
    assert manifest["format"] == "irovoice" and manifest["version"] == 1
    assert manifest["consent"] == original["consent"]
    assert [c["file"] for c in manifest["clips"]] == ["clips/01.flac", "clips/02.flac"]
    assert sf.info(io.BytesIO(archive.read("clips/01.flac"))).format == "FLAC"
    assert not any(name.endswith(".pt") for name in archive.namelist())  # no latents

    imported = client.post(
        "/voices/import", files={"file": ("v.irovoice", exported.content, "application/zip")}
    )
    assert imported.status_code == 201, imported.text
    copy = _finish(client, imported.json())
    assert copy["id"] != original["id"] and copy["name"] == "パッケージ"
    assert copy["consent"] == original["consent"]  # provenance kept, incl. confirmed_at
    assert [round(c["duration_s"], 2) for c in copy["clips"]] == [1.0, 1.5]
    assert copy["params_default"] == {"num_steps": 24} and copy["seed_default"] == 42

    # A package whose consent record was removed is refused.
    tampered = io.BytesIO()
    with zipfile.ZipFile(tampered, "w") as out:
        for name in archive.namelist():
            data = archive.read(name)
            if name == "voice.json":
                data = json.dumps({**manifest, "consent": None}).encode("utf-8")
            out.writestr(name, data)
    refused = client.post(
        "/voices/import", files={"file": ("v.irovoice", tampered.getvalue(), "application/zip")}
    )
    assert refused.json()["code"] == "consent_required"
    junk = client.post("/voices/import", files={"file": ("v.irovoice", b"nope", "application/zip")})
    assert junk.json()["code"] == "package_invalid"

    written = client.post(
        f"/voices/{original['id']}/export", json={"path": str(tmp_path / "exported")}
    )
    assert written.status_code == 200, written.text
    assert Path(written.json()["path"]).name == "exported.irovoice"
    assert Path(written.json()["path"]).stat().st_size == written.json()["bytes"]


def test_unowned_clips_are_purged(make_client) -> None:
    client, _ = make_client()
    wait_ready(client)
    loose = _clip(client)
    kept = _clip(client)
    saved = client.post(
        "/voices",
        json={"name": "v", "source": "imported", "clip_ids": [kept], "consent": CONSENT},
    )
    assert saved.status_code == 201, saved.text
    services = client.app.state.services  # type: ignore[attr-defined]

    assert services.clips.purge_unowned() == 0  # younger than a day
    with services.db.transaction() as conn:
        conn.execute("UPDATE clips SET created_at = '2000-01-01T00:00:00.000Z'")
    assert services.clips.purge_unowned() == 1
    assert client.get(f"/clips/{loose}").status_code == 404
    assert client.get(f"/clips/{kept}").status_code == 200


def test_embedding_files_must_fit_the_runtime(make_client, tmp_path: Path) -> None:
    client, _ = make_client()
    wait_ready(client)

    def refused(array: np.ndarray, name: str) -> dict:
        path = tmp_path / f"{name}.speaker.safetensors"
        save_file({"speaker_embedding": array}, str(path))
        response = client.post(
            "/voices", json={"name": name, "source": "embedding", "embedding_path": str(path)}
        )
        assert response.status_code == 422, response.text
        assert response.json()["code"] == "embedding_invalid"
        return response.json()["detail"]

    # Upstream's inference path needs (tokens, dim) exactly: no batch axis.
    assert refused(np.zeros((1, 4, 768), np.float32), "batched")["reason"] == "shape"
    assert refused(np.zeros((4, 512), np.float32), "narrow")["reason"] == "dim"
    assert refused(np.zeros((4, 768), np.int32), "integers")["reason"] == "dtype"
