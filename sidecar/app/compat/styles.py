"""VOICEVOX styles of a library voice: the voice as saved, and the style presets — a
caption for manner and mood that combines well with reference audio.

The captions and names mirror `src/features/quick/stylePresets.ts` (the Quick screen's
presets and their Japanese labels); keep the two in step. Captions are model input and
names are protocol data, so both are Japanese.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Style:
    key: str
    name: str
    caption: str | None  # None: the voice's own caption


STYLES: tuple[Style, ...] = (
    Style("normal", "ノーマル", None),
    Style("calm", "落ち着いて", "落ち着いた自然な声で、穏やかに話している。"),
    Style("bright", "明るく", "明るく元気な声で、楽しそうに話している。"),
    Style("gentle", "優しく", "優しく柔らかい声で、語りかけるように話している。"),
    Style("whisper", "ささやき", "耳元でささやくような、小さく近い声。"),
    Style("sad", "悲しげに", "悲しげで沈んだ声。今にも泣き出しそうに話している。"),
    Style("angry", "怒って", "怒っていて、強くとげのある口調で話している。"),
    Style("excited", "興奮して", "興奮気味で、勢いよく早口で話している。"),
    Style("sleepy", "眠そうに", "眠そうで気だるげな、ゆっくりとした声。"),
    Style(
        "narration",
        "ナレーション",
        "落ち着いたナレーション。はっきりと聞き取りやすく読み上げている。",
    ),
    Style(
        "announcer",
        "アナウンサー",
        "ニュースを読み上げるアナウンサーのような、明瞭で落ち着いた声。",
    ),
)
