"""Text processing for narration (Session 5): user dictionary, chunking, Markdown,
subtitles, joining takes, readings. No torch, no model."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest

from app.audio import assemble
from app.errors import ApiError
from app.schemas import DictionaryEntryInput
from app.storage.db import Database
from app.text import srt
from app.text.chunker import markdown_to_text, paragraphs, sentences_of, split_text
from app.text.dictionary import DictionaryStore
from app.text.reading import Reader


def _chars(text: str) -> float:
    return len(text) / 5.0  # 5 characters per second, for predictable tests


def _store(tmp_path: Path, *entries: tuple[str, str, bool]) -> DictionaryStore:
    store = DictionaryStore(Database(tmp_path / "db.sqlite"))
    store.replace([DictionaryEntryInput(surface=s, reading=r, enabled=on) for s, r, on in entries])
    return store


def test_dictionary_longest_match_width_and_disabled(tmp_path: Path) -> None:
    store = _store(
        tmp_path,
        ("東京", "トウキョウ", True),
        ("東京都", "トーキョート", True),
        ("AI", "エーアイ", True),
        ("昨日", "サクジツ", False),
    )
    applied = store.apply("東京都と東京でＡＩとAIを使った昨日の話")
    assert applied.text == "トーキョートとトウキョウでエーアイとエーアイを使った昨日の話"
    assert applied.replacements == 4
    assert [s.entry.surface for s in applied.segments if s.entry] == ["東京都", "東京", "AI", "AI"]
    assert "".join(s.text for s in applied.segments) == applied.text


def test_dictionary_validation(tmp_path: Path) -> None:
    store = DictionaryStore(Database(tmp_path / "db.sqlite"))
    with pytest.raises(ApiError) as duplicate:
        store.replace(
            [
                DictionaryEntryInput(surface="ＡＩ", reading="エーアイ"),
                DictionaryEntryInput(surface="AI", reading="アイ"),
            ]
        )
    assert duplicate.value.detail == {"reason": "duplicate", "index": 1, "other": 0}
    with pytest.raises(ApiError):
        store.replace([DictionaryEntryInput(surface="改\n行", reading="カイギョウ")])
    assert store.list() == []
    assert store.apply("そのまま").text == "そのまま"


def test_sentences_keep_quotes_together() -> None:
    assert sentences_of("「こんにちは。」と言った。次の文！\u3000最後") == [
        "「こんにちは。」と言った。",
        "次の文！",
        "最後",
    ]
    assert sentences_of("「はい。」「いいえ。」") == ["「はい。」", "「いいえ。」"]
    assert sentences_of("3.5秒です。Mr. Smith") == ["3.5秒です。", "Mr.", "Smith"]
    assert paragraphs("一文目。\n二文目。\n\n\n三文目。") == [
        ["一文目。", "二文目。"],
        ["三文目。"],
    ]


def test_split_packs_sentences_within_limits() -> None:
    sentence = "これは十五文字くらいの文です。"  # 15 characters
    text = sentence * 12 + "\n\n" + "短い段落。"
    drafts = split_text(text, min_chars=40, max_chars=60, max_seconds=20, estimate=_chars)
    assert [len(d.text) for d in drafts] == [45, 45, 45, 45, 5]
    assert all(len(d.text) <= 60 for d in drafts)
    assert [d.pause_after for d in drafts] == ["sentence"] * 3 + ["paragraph", "paragraph"]
    assert drafts[0].estimated_seconds == pytest.approx(9.0)


def test_long_sentences_split_at_clauses_then_by_length() -> None:
    clause = "長い説明がここに続いていて、"  # 14 characters, ends with a clause mark
    long_sentence = clause * 6 + "終わり。"
    drafts = split_text(long_sentence, min_chars=20, max_chars=30, max_seconds=100, estimate=_chars)
    assert all(len(d.text) <= 30 for d in drafts)
    assert "".join(d.text for d in drafts) == long_sentence
    assert [d.pause_after for d in drafts][:-1] == ["clause"] * (len(drafts) - 1)
    # No clause marks at all: cut by length, also to respect the seconds limit.
    solid = "あ" * 95 + "。"
    pieces = split_text(solid, min_chars=10, max_chars=40, max_seconds=5, estimate=_chars)
    assert all(d.estimated_seconds <= 5 for d in pieces)
    assert "".join(d.text for d in pieces) == solid


def test_short_tail_joins_the_previous_chunk() -> None:
    text = "あ" * 30 + "。" + "い" * 30 + "。" + "はい。"
    drafts = split_text(text, min_chars=30, max_chars=80, max_seconds=100, estimate=_chars)
    assert [d.text for d in drafts] == ["あ" * 30 + "。", "い" * 30 + "。" + "はい。"]


def test_markdown_to_text() -> None:
    markdown = (
        "# 第一章\n\n本文の**強調**と[リンク](https://example.com)と`コード`。\n"
        "- 項目その一\n1. 番号付き\n> 引用です\n\n```\nprint('x')\n```\n"
        "![画像](a.png)<br>\n---\n| 列A | 列B |\n|---|---|\n| 値1 | 値2 |\n"
    )
    text = markdown_to_text(markdown)
    assert "#" not in text and "*" not in text and "print" not in text and "http" not in text
    assert paragraphs(text) == [
        ["第一章"],
        ["本文の強調とリンクとコード。", "項目その一", "番号付き", "引用です"],
        ["列A、列B", "値1、値2"],
    ]


def test_subtitles_parse_and_write() -> None:
    source = (
        "\ufeff1\r\n00:00:01,000 --> 00:00:03,500\r\n<i>一行目</i>\r\n二行目\r\n\r\n"
        "2\r\n00:00:04,250 --> 00:00:06,000\r\nHello\r\nworld\r\n"
    )
    cues = srt.parse(source)
    assert cues == [
        srt.Cue(1000, 3500, "一行目二行目"),
        srt.Cue(4250, 6000, "Hello world"),
    ]
    assert srt.parse(srt.to_srt(cues)) == cues
    vtt = srt.to_vtt(cues)
    assert vtt.startswith("WEBVTT\n\n1\n00:00:01.000 --> 00:00:03.500\n")
    assert srt.parse(vtt) == cues
    assert srt.parse("WEBVTT\n\n01:02.5 --> 01:04.000 line:0\n<v Taro>やあ\n") == [
        srt.Cue(62500, 64000, "やあ")
    ]
    assert srt.looks_like_subtitles(source) and not srt.looks_like_subtitles("ただの文章。")
    with pytest.raises(srt.SubtitleError):
        srt.parse("字幕ではない")


def test_trim_and_join_takes() -> None:
    rate = 1000
    speech = np.full(200, 0.5, dtype=np.float32)
    padded = np.concatenate([np.zeros(300, np.float32), speech, np.zeros(400, np.float32)])
    trimmed = assemble.trim_silence(padded, rate)
    # 30 ms kept before the sound, 60 ms after it.
    assert len(trimmed) == 30 + 200 + 60
    assert len(assemble.trim_silence(np.zeros(500, np.float32), rate)) == 500

    audio, placed = assemble.join([speech, speech, speech], rate, gaps_ms=[100, 250, 999])
    assert [p.start for p in placed] == [0, 300, 750]
    assert len(audio) == 950  # no gap after the last take
    audio, placed = assemble.join([speech, speech], rate, starts_ms=[500, 600])
    assert [p.start for p in placed] == [500, 700]  # the second waits for the first
    assert len(audio) == 900


def test_readings_and_estimates() -> None:
    reader = Reader()
    if not reader.available:
        pytest.skip("pyopenjtalk-plus is not installed")
    tokens = reader.tokens("東京で100人が集まった。")
    readings = "".join(t.reading for t in tokens if t.kind == "analyzer")
    assert "トウキョウ" in readings and "ヒャク" in readings
    assert any(t.kind == "symbol" and t.surface == "。" for t in tokens)
    assert reader.moras("あいうえお") == 5
    short, long = reader.estimate_seconds("はい。"), reader.estimate_seconds("はい。" * 10)
    assert 0 < short < long
