"""Library (Session 7): history filters, usage, generating an entry again, exporting
entries with a naming template, pruning by count and size, and parameter presets."""

from __future__ import annotations

import io
from pathlib import Path

import numpy as np
import soundfile as sf
from conftest import generate, read_events, wait_ready

from app.schemas import Preferences
from app.services.history import HistoryStore, NewEntry
from app.storage.db import Database
from app.storage.files import DataLayout

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


def test_filters_usage_and_regenerate(make_client) -> None:
    client, backend = make_client()
    wait_ready(client)
    voice = _voice(client, "声A")
    read_events(client, generate(client, text="一つ目です。"))
    middle = client.get("/history").json()["items"][0]["created_at"]
    read_events(
        client,
        generate(client, text="二つ目です。", reference={"kind": "voice", "voice_id": voice}),
    )
    read_events(client, generate(client, text="三つ目です。", caption="明るく"))

    everything = client.get("/history").json()
    assert everything["total"] == 3
    assert everything["items"][1]["voice_id"] == voice
    by_voice = client.get("/history", params={"voice": voice}).json()
    assert [e["text"] for e in by_voice["items"]] == ["二つ目です。"]
    no_voice = client.get("/history", params={"voice": "none"}).json()
    assert [e["text"] for e in no_voice["items"]] == ["三つ目です。", "一つ目です。"]
    later = client.get("/history", params={"since": middle, "q": "つ目"}).json()
    assert later["total"] == 3
    earlier = client.get("/history", params={"before": middle}).json()
    assert earlier["total"] == 0
    caption = client.get("/history", params={"q": "明るく"}).json()
    assert [e["text"] for e in caption["items"]] == ["三つ目です。"]

    usage = client.get("/history/usage").json()
    assert usage["entries"] == 3 and usage["bytes"] >= 3 * 9600

    # The same request again: same text and seed; `seed: null` draws a new one.
    first = everything["items"][2]
    again = client.post(f"/history/{first['id']}/regenerate", json={})
    assert again.status_code == 202, again.text
    done = read_events(client, again.json()["job_id"])[-1]
    assert done[0] == "completed" and done[1]["used_seed"] == first["used_seed"]
    assert backend.requests[-1].text == "一つ目です。"
    fresh = client.post(
        f"/history/{first['id']}/regenerate", json={"seed": None, "num_candidates": 2}
    ).json()
    result = read_events(client, fresh["job_id"])[-1][1]
    assert len(result["outputs"]) == 2
    assert client.get("/history").json()["total"] == 5
    missing = client.post("/history/" + "0" * 26 + "/regenerate", json={})
    assert (missing.status_code, missing.json()["code"]) == (404, "history_not_found")


def test_export_entries_with_names(make_client, tmp_path: Path) -> None:
    client, _ = make_client()
    wait_ready(client)
    read_events(client, generate(client, text="同じ文です。", params={"num_candidates": 2}))
    read_events(client, generate(client, text="同じ文です。"))
    items = client.get("/history").json()["items"]
    older = items[1]
    client.patch(
        f"/history/{older['id']}", json={"adopted_audio_id": older["outputs"][1]["audio_id"]}
    )

    folder = tmp_path / "export"
    folder.mkdir()
    exported = client.post(
        "/history/export",
        json={
            "history_ids": [older["id"], items[0]["id"]],
            "folder": str(folder),
            "naming_template": "{index}_{text_head}",
        },
    )
    assert exported.status_code == 200, exported.text
    names = [Path(f["path"]).name for f in exported.json()["files"]]
    assert names == ["001_同じ文です。.wav", "002_同じ文です。.wav"]
    adopted = client.get(f"/audio/{older['outputs'][1]['audio_id']}").content
    assert (folder / names[0]).read_bytes() == adopted  # the adopted candidate, as generated

    same = client.post(
        "/history/export",
        json={
            "history_ids": [older["id"], items[0]["id"]],
            "folder": str(folder),
            "naming_template": "x",
        },
    ).json()
    assert [Path(f["path"]).name for f in same["files"]] == ["x.wav", "x_2.wav"]
    bad = client.post(
        "/history/export",
        json={"history_ids": [older["id"]], "folder": str(folder), "naming_template": "{speaker}"},
    )
    assert (bad.status_code, bad.json()["code"]) == (422, "naming_template_invalid")
    nowhere = client.post(
        "/history/export", json={"history_ids": [older["id"]], "folder": str(tmp_path / "none")}
    )
    assert nowhere.json()["code"] == "save_path_invalid"


def test_pruning_by_count_and_size(make_client, tmp_path: Path) -> None:
    client, _ = make_client()
    wait_ready(client)
    for n in range(4):
        read_events(client, generate(client, text=f"{n}番目。"))
    limited = client.patch("/preferences", json={"history_max_entries": 2}).json()
    assert limited["history_max_entries"] == 2
    kept = client.get("/history").json()
    assert [e["text"] for e in kept["items"]] == ["3番目。", "2番目。"]
    read_events(client, generate(client, text="4番目。"))
    assert client.get("/history").json()["total"] == 2

    # Size: 1-second entries (≈ 96 KB) against a 250 KB limit keep the newest two.
    store = HistoryStore(Database(tmp_path / "size.db"), DataLayout(tmp_path / "size"))
    for n in range(4):
        store.record(_entry(n), [np.zeros(48000, dtype=np.float32)], 48000)
    store.prune(Preferences.model_construct(history_max_entries=100, history_max_bytes=250_000))
    page = store.list(limit=10, offset=0)
    assert [e.text for e in page.items] == ["3", "2"]
    assert store.usage().bytes <= 250_000


def _entry(n: int) -> NewEntry:
    return NewEntry(
        model_id="m", text=str(n), caption=None, reference_kind="none", request={}, params={},
        used_seed=n, timings={}, messages=[], watermarked=False, device="cpu", precision="fp32",
    )  # fmt: skip


def test_presets(make_client) -> None:
    client, _ = make_client()
    wait_ready(client)
    created = client.post(
        "/presets", json={"name": "ゆっくり", "params": {"num_steps": 60, "seed": 5}}
    )
    assert created.status_code == 201, created.text
    preset = created.json()
    assert preset["params"] == {"num_steps": 60, "seed": 5}  # only what was given
    client.post("/presets", json={"name": "あっさり", "params": {"num_steps": 20}})
    assert [p["name"] for p in client.get("/presets").json()] == ["あっさり", "ゆっくり"]

    renamed = client.patch(f"/presets/{preset['id']}", json={"name": "丁寧"}).json()
    assert renamed["name"] == "丁寧" and renamed["params"] == {"num_steps": 60, "seed": 5}
    changed = client.patch(
        f"/presets/{preset['id']}", json={"params": {"speaker_kv_min_t": None}}
    ).json()
    assert changed["params"] == {"speaker_kv_min_t": None}  # null ("off") is kept
    invalid = client.post("/presets", json={"name": "x", "params": {"num_steps": 999}})
    assert (invalid.status_code, invalid.json()["code"]) == (422, "invalid_params")
    assert client.delete(f"/presets/{preset['id']}").status_code == 204
    assert client.delete(f"/presets/{preset['id']}").json()["code"] == "preset_not_found"
    assert client.patch("/presets/" + "0" * 26, json={"name": "y"}).status_code == 404
