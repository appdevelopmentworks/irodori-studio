"""Scripts (Session 6): parsing text and tables, the speaker → voice map with voice
defaults, per-line overrides, rendering with takes, line edits, assembly with pauses and
speaker subtitles, per-line file names, and CSV / TSV round trips. Fake backend: every
take is 0.1 s of noise."""

from __future__ import annotations

import io
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf
from conftest import read_events, wait_ready

from app.text import srt
from app.text.script_parser import LineDraft, ScriptError, parse_table, parse_text, to_table

CONSENT = {"statement": "本人の同意を得ています（テスト用の同意文）。", "locale": "ja"}


def test_parse_text_formats() -> None:
    lines = parse_text(
        "太郎：おはよう。\n"
        "花子: 「おはようございます」\n"
        "（二人は歩き出す）\n"
        "太郎「いい天気だね」\n"
        "\n"
        "本当に。\n"
        "ナレーター：時刻は午前八時。http://example.com\n"
    )
    assert [(line.speaker, line.text) for line in lines] == [
        ("太郎", "おはよう。"),
        ("花子", "おはようございます"),
        ("太郎", "いい天気だね"),
        ("太郎", "本当に。"),
        ("ナレーター", "時刻は午前八時。http://example.com"),
    ]
    with pytest.raises(ScriptError):
        parse_text("（ト書きだけ）\n\n")


def test_parse_tables_and_round_trip() -> None:
    csv_text = (
        "No,キャラクター,セリフ,キャプション,候補数,シード,行後の間,ファイル名,メモ\r\n"
        '1,太郎,"こんにちは、""世界""。",明るく,2,42,300,hello,無視される列\r\n'
        '2,花子,"改行を\n含むセリフ",,,,,,\r\n'
        "3,,,,,,,,\r\n"
    )
    lines = parse_table(csv_text)
    assert lines == [
        LineDraft("太郎", 'こんにちは、"世界"。', "明るく", 2, 42, 300, "hello"),
        LineDraft("花子", "改行を\n含むセリフ"),
    ]
    for delimiter in (",", "\t"):
        assert parse_table(to_table(lines, delimiter)) == lines  # delimiter is detected
    headerless = parse_table("太郎\tやあ\n花子\tどうも\n")
    assert [(line.speaker, line.text) for line in headerless] == [
        ("太郎", "やあ"),
        ("花子", "どうも"),
    ]
    with pytest.raises(ScriptError) as bad:
        parse_table("speaker,text,seed\n太郎,やあ,x\n")
    assert bad.value.detail == {"row": 2, "column": "seed"}
    with pytest.raises(ScriptError):
        parse_table("speaker,seed\n太郎,1\n")  # no text column


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


def _script(client, source: str, **body: object) -> dict:  # type: ignore[no-untyped-def]
    response = client.post("/scripts", json={"source": source, **body})
    assert response.status_code == 201, response.text
    return response.json()


def _render(client, script_id: str, **body: object) -> list[tuple[str, dict]]:  # type: ignore[no-untyped-def]
    response = client.post(f"/scripts/{script_id}/render", json=body)
    assert response.status_code == 200, response.text
    assert response.json() is not None
    return read_events(client, response.json()["job_id"])


def test_voices_defaults_and_line_overrides(make_client) -> None:
    client, backend = make_client()
    wait_ready(client)
    taro = _voice(client, "太郎の声", caption_default="元気な少年。", seed_default=7)
    hanako = _voice(client, "花子の声", params_default={"num_steps": 20})
    script = _script(
        client,
        "太郎：一行目。\n花子：二行目。\n太郎：三行目。\nナレーター：四行目。",
        settings={"params": {"num_steps": 30}},
    )
    assert [s["name"] for s in script["speakers"]] == ["太郎", "花子", "ナレーター"]
    # Only the parameters that were given come back: omitted is not the same as null.
    assert script["settings"]["params"] == {"num_steps": 30}
    off = {"params": {"num_steps": 30, "speaker_kv_min_t": None}}
    patched = client.patch(f"/scripts/{script['id']}", json={"settings": off}).json()
    assert patched["settings"]["params"] == {"num_steps": 30, "speaker_kv_min_t": None}
    mapped = client.patch(
        f"/scripts/{script['id']}",
        json={
            "speakers": [
                {"name": "太郎", "voice_id": taro},
                {"name": "花子", "voice_id": hanako, "caption": "落ち着いた声。"},
            ]
        },
    ).json()
    # A speaker the lines use keeps an entry even if the map left it out.
    assert [s["name"] for s in mapped["speakers"]] == ["太郎", "花子", "ナレーター"]
    third = mapped["lines"][2]["id"]
    client.patch(
        f"/scripts/{script['id']}/lines/{third}",
        json={"caption": "ささやく声。", "seed": 99, "num_candidates": 2},
    )

    events = _render(client, script["id"])
    line_events = [data for kind, data in events if kind == "line"]
    assert [e["index"] for e in line_events] == [0, 1, 2, 3]
    assert [len(e["takes"]) for e in line_events] == [1, 1, 2, 1]
    assert events[-1] == ("completed", {"script_id": script["id"], "rendered": 4})
    r1, r2, r3, r4 = backend.requests[-4:]
    # voice defaults < script settings < the line's own values
    assert (r1.caption, r1.seed, r1.params["num_steps"]) == ("元気な少年。", 7, 30)
    assert (r2.caption, r2.params["num_steps"]) == ("落ち着いた声。", 30)
    assert (r3.caption, r3.seed, r3.params["num_candidates"]) == ("ささやく声。", 99, 2)
    assert r4.caption is None and r4.ref_latents == ()  # no voice: nothing to reference
    assert all(len(r.ref_latents) == 1 for r in (r1, r2, r3))


def test_line_edits_keep_or_drop_takes(make_client) -> None:
    client, _ = make_client()
    wait_ready(client)
    script = _script(client, "A：一。\nB：二。\nA：三。")
    _render(client, script["id"])
    lines = client.get(f"/scripts/{script['id']}").json()["lines"]
    first, second, third = (line["id"] for line in lines)

    moved = client.post(f"/scripts/{script['id']}/lines/{third}/move", json={"position": 0}).json()
    assert [line["id"] for line in moved["lines"]] == [third, first, second]
    assert all(line["adopted_audio_id"] for line in moved["lines"])  # takes follow their lines

    paused = client.patch(f"/scripts/{script['id']}/lines/{first}", json={"pause_ms": 50}).json()
    assert paused["lines"][1]["pause_ms"] == 50 and paused["lines"][1]["takes"]
    edited = client.patch(f"/scripts/{script['id']}/lines/{first}", json={"text": "いち。"}).json()
    assert edited["lines"][1]["takes"] == [] and edited["lines"][1]["adopted_audio_id"] is None
    speaker = client.patch(f"/scripts/{script['id']}/lines/{second}", json={"speaker": "C"}).json()
    assert speaker["lines"][2]["takes"] == [] and "C" in [s["name"] for s in speaker["speakers"]]

    inserted = client.post(
        f"/scripts/{script['id']}/lines",
        json={"line": {"speaker": "B", "text": "挿入。"}, "position": 1},
    ).json()
    assert [line["text"] for line in inserted["lines"]] == ["三。", "挿入。", "いち。", "二。"]
    deleted = client.delete(f"/scripts/{script['id']}/lines/{inserted['lines'][1]['id']}").json()
    assert [line["index"] for line in deleted["lines"]] == [0, 1, 2]
    missing = client.post(f"/scripts/{script['id']}/assemble")
    assert (missing.status_code, missing.json()["code"]) == (409, "script_incomplete")
    events = _render(client, script["id"])  # resume: only the lines without a take
    assert events[-1][1]["rendered"] == 2


def test_drama_export_names_and_subtitles(make_client, tmp_path: Path) -> None:
    client, _ = make_client()
    wait_ready(client)
    speakers = ["太郎", "花子", "ナレーター"]
    source = "\n".join(f"{speakers[i % 3]}：これは{i + 1}行目のセリフです。" for i in range(21))
    script = _script(client, source, title="第一話", settings={"pause_ms": 200})
    lines = script["lines"]
    client.patch(f"/scripts/{script['id']}/lines/{lines[2]['id']}", json={"pause_ms": 700})
    client.patch(
        f"/scripts/{script['id']}/lines/{lines[5]['id']}", json={"file_name": "special/name"}
    )
    _render(client, script["id"])

    folder = tmp_path / "out"
    folder.mkdir()
    exported = client.post(
        f"/scripts/{script['id']}/export",
        json={"folder": str(folder), "subtitles": ["srt", "vtt"]},
    )
    assert exported.status_code == 200, exported.text
    names = [Path(f["path"]).name for f in exported.json()["files"]]
    assert len(names) == 21 + 3
    assert names[0] == "001_太郎_これは1行目のセリフです.wav"  # the text's first 12 characters
    assert names[5] == "special_name.wav"  # the line's own name, made safe
    assert names[20] == "021_ナレーター_これは21行目のセリフで.wav"
    assert names[-3:] == ["第一話.wav", "第一話.srt", "第一話.vtt"]
    assert all((folder / name).is_file() for name in names)

    cues = srt.parse((folder / "第一話.srt").read_text(encoding="utf-8"))
    assert len(cues) == 21 and cues[0].text == "太郎：これは1行目のセリフです。"
    # 0.1 s takes: 200 ms after each line, 700 ms after line 3.
    assert [(c.start_ms, c.end_ms) for c in cues[:4]] == [
        (0, 100),
        (300, 400),
        (600, 700),
        (1400, 1500),
    ]
    vtt = (folder / "第一話.vtt").read_text(encoding="utf-8")
    assert "<v 花子>これは2行目のセリフです。" in vtt

    template = client.patch(
        f"/scripts/{script['id']}",
        json={"settings": {"naming_template": "{title}-{n}-{speaker}", "pause_ms": 200}},
    )
    assert template.status_code == 200
    again = client.post(
        f"/scripts/{script['id']}/export",
        json={"folder": str(folder), "merged": False, "format": "wav"},
    ).json()
    assert Path(again["files"][0]["path"]).name == "第一話-1-太郎.wav"
    bad = client.patch(
        f"/scripts/{script['id']}", json={"settings": {"naming_template": "{index}_{unknown}"}}
    )
    assert (bad.status_code, bad.json()["code"]) == (422, "naming_template_invalid")
    preview = client.post(
        f"/scripts/{script['id']}/file-names", json={"naming_template": "{speaker}/{n}"}
    ).json()
    assert preview["names"][:3] == ["太郎_1", "花子_2", "ナレーター_3"]
    assert preview["names"][5] == "special_name"
    unknown = client.post(
        f"/scripts/{script['id']}/file-names", json={"naming_template": "{nope}"}
    ).json()
    assert unknown["code"] == "naming_template_invalid" and unknown["detail"] == {"token": "nope"}


def test_table_round_trip_through_the_api(make_client, tmp_path: Path) -> None:
    client, _ = make_client()
    wait_ready(client)
    source = (
        "index,speaker,text,caption,candidates,seed,pause_ms,file\n"
        '1,太郎,"カンマ, と ""引用""",明るく,2,5,300,t1\n'
        "2,花子,普通のセリフ,,,,,\n"
    )
    script = _script(client, source, format="csv")
    for fmt in ("csv", "tsv"):
        path = tmp_path / f"table.{fmt}"
        written = client.post(
            f"/scripts/{script['id']}/table",
            json={"path": str(path.with_suffix("")), "format": fmt},
        )
        assert written.status_code == 200, written.text
        data = path.read_bytes()
        assert data.startswith(b"\xef\xbb\xbf")  # UTF-8 with a BOM, for Excel
        copy = _script(client, data.decode("utf-8"), format=fmt)
        fields = ("speaker", "text", "caption", "num_candidates", "seed", "pause_ms", "file_name")
        assert [[line[f] for f in fields] for line in copy["lines"]] == [
            [line[f] for f in fields] for line in script["lines"]
        ]
    invalid = client.post("/scripts", json={"source": "speaker\n太郎\n", "format": "csv"})
    assert (invalid.status_code, invalid.json()["code"]) == (422, "script_invalid")
    assert invalid.json()["detail"]["reason"] == "header"

    appended = client.post(
        f"/scripts/{script['id']}/import",
        json={"source": "三郎：追加の行。", "mode": "append"},
    ).json()
    assert [line["speaker"] for line in appended["lines"]] == ["太郎", "花子", "三郎"]
    listed = client.get("/scripts").json()
    assert {s["id"] for s in listed} >= {script["id"]}
    assert client.delete(f"/scripts/{script['id']}").status_code == 204


def test_busy_cancel_redo_and_adopt(make_client) -> None:
    client, backend = make_client()
    wait_ready(client)
    script = _script(client, "A：一。\nB：二。")
    backend.blocking = True
    job_id = client.post(f"/scripts/{script['id']}/render", json={}).json()["job_id"]
    assert backend.started.wait(5)
    assert client.get(f"/scripts/{script['id']}").json()["render_job_id"] == job_id
    busy = client.post(f"/scripts/{script['id']}/import", json={"source": "C：三。"})
    assert (busy.status_code, busy.json()["code"]) == (409, "script_busy")
    assert client.delete(f"/scripts/{script['id']}").status_code == 409
    assert client.post(f"/jobs/{job_id}/cancel").json()["state"] == "cancelling"
    assert read_events(client, job_id)[-1][0] == "cancelled"

    backend.blocking = False
    events = _render(client, script["id"])
    assert events[-1][1]["rendered"] == 2
    first = client.get(f"/scripts/{script['id']}").json()["lines"][0]
    redo = _render(client, script["id"], line_ids=[first["id"]], redo=True, num_candidates=3)
    line = next(data for kind, data in redo if kind == "line")
    assert line["line_id"] == first["id"] and len(line["takes"]) == 3
    current = client.get(f"/scripts/{script['id']}").json()["lines"][0]
    assert (
        len(current["takes"]) == 4 and current["adopted_audio_id"] == line["takes"][0]["audio_id"]
    )
    kept = current["takes"][0]["audio_id"]
    adopted = client.patch(
        f"/scripts/{script['id']}/lines/{first['id']}", json={"adopted_audio_id": kept}
    )
    assert adopted.json()["lines"][0]["adopted_audio_id"] == kept
    stranger = client.patch(
        f"/scripts/{script['id']}/lines/{first['id']}", json={"adopted_audio_id": "0" * 26}
    )
    assert (stranger.status_code, stranger.json()["code"]) == (404, "audio_not_found")
    assert client.post(f"/scripts/{script['id']}/render", json={}).json() is None
    unknown = client.post(f"/scripts/{script['id']}/render", json={"line_ids": ["0" * 26]})
    assert (unknown.status_code, unknown.json()["code"]) == (404, "line_not_found")
    assert client.get("/scripts/" + "0" * 26).json()["code"] == "script_not_found"


def test_job_info_and_assembled_audio(make_client) -> None:
    client, _ = make_client()
    wait_ready(client)
    script = _script(
        client, "A：一。\nB：二。", settings={"pause_ms": 0, "subtitle_speakers": False}
    )
    job_id = client.post(f"/scripts/{script['id']}/render", json={}).json()["job_id"]
    read_events(client, job_id)
    info = client.get(f"/jobs/{job_id}").json()
    assert info["kind"] == "script"
    assert info["result"] == {"script_id": script["id"], "rendered": 2}
    assembled = client.post(f"/scripts/{script['id']}/assemble").json()
    assert assembled["duration_s"] == 0.2
    assert [(c["speaker"], c["start_ms"], c["end_ms"]) for c in assembled["cues"]] == [
        ("A", 0, 100),
        ("B", 100, 200),
    ]
    assert client.get(f"/audio/{assembled['audio_id']}").status_code == 200
    assert client.get(f"/scripts/{script['id']}").json()["assembled"] == assembled
    listed = client.get("/scripts").json()
    assert listed[0] | {"updated_at": ""} == {
        "id": script["id"],
        "title": "一。",
        "created_at": script["created_at"],
        "updated_at": "",
        "lines": 2,
        "rendered": 2,
        "speakers": 2,
    }
