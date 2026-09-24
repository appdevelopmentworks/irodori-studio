"""Model registry (D5) and the watermark policy (D12)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.engine.registry import load_registry
from app.schemas import Preferences, SynthesisRequest
from app.services import policy


def test_registry_loads_the_default_model() -> None:
    registry = load_registry()
    spec = registry.default
    assert spec.id == registry.default_model
    caps = spec.capabilities
    assert caps.caption and caps.speaker_reference and caps.speaker_embedding
    assert caps.sampling == "rf"
    assert caps.max_output_seconds == 30.0 and caps.max_ref_seconds == 120.0
    assert registry.get("missing") is None


def test_registry_rejects_an_unknown_default(tmp_path: Path) -> None:
    raw = json.loads((Path(__file__).resolve().parents[1] / "models.json").read_text("utf-8"))
    raw["default_model"] = "nope"
    path = tmp_path / "models.json"
    path.write_text(json.dumps(raw), encoding="utf-8")
    with pytest.raises(ValueError):
        load_registry(path)


def _request(kind: str) -> SynthesisRequest:
    reference = {
        "none": {"kind": "none"},
        "clips": {"kind": "clips", "clip_ids": ["01J0000000000000000000000A"]},
        "embedding": {"kind": "embedding", "path": "/x.speaker.safetensors"},
    }[kind]
    return SynthesisRequest.model_validate({"text": "テスト", "reference": reference})


@pytest.mark.parametrize("kind", ["none", "clips", "embedding"])
def test_watermark_follows_the_setting_by_default(kind: str) -> None:
    assert policy.watermark_policy(_request(kind), Preferences()) is True
    off = Preferences(watermark_enabled=False)
    assert policy.watermark_policy(_request(kind), off) is False


def test_option_b_forces_the_watermark_for_cloning(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(policy, "FORCE_WATERMARK_FOR_CLONING", True)
    off = Preferences(watermark_enabled=False)
    assert policy.watermark_policy(_request("none"), off) is False
    assert policy.watermark_policy(_request("clips"), off) is True
    assert policy.watermark_policy(_request("embedding"), off) is True
