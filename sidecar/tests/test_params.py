"""The single parameter table (D26): upstream names, Space defaults, validation, schema."""

from __future__ import annotations

import ast
from dataclasses import replace
from pathlib import Path

import pytest

from app.engine import params
from app.engine.registry import load_registry
from app.schemas import SamplingParams

UPSTREAM_RUNTIME = (
    Path(__file__).resolve().parents[2]
    / "third_party"
    / "Irodori-TTS"
    / "irodori_tts"
    / "inference_runtime.py"
)
CAPS = load_registry().default.capabilities


def _sampling_request_fields() -> set[str]:
    tree = ast.parse(UPSTREAM_RUNTIME.read_text(encoding="utf-8"))
    for node in tree.body:
        if isinstance(node, ast.ClassDef) and node.name == "SamplingRequest":
            return {
                item.target.id
                for item in node.body
                if isinstance(item, ast.AnnAssign) and isinstance(item.target, ast.Name)
            }
    raise AssertionError("SamplingRequest not found upstream")


def _resolve(provided: dict | None = None, **kwargs: object) -> dict[str, object]:
    options = {"reference_kind": "none", "has_caption": False, **kwargs}
    return params.resolve(provided or {}, CAPS, **options)  # type: ignore[arg-type]


def test_every_parameter_is_an_upstream_sampling_request_field() -> None:
    assert params.NAMES <= _sampling_request_fields()


def test_request_schema_lists_exactly_the_table() -> None:
    assert set(SamplingParams.model_fields) == params.NAMES


def test_space_defaults() -> None:
    values = _resolve()
    assert values["num_steps"] == 40
    assert values["num_candidates"] == 1
    assert values["seed"] is None
    assert values["cfg_scale_text"] == 3.0
    assert values["cfg_scale_caption"] == 4.0  # Space, not the CLI's 3.0 (D26)
    assert values["cfg_scale_speaker"] == 5.0
    assert values["cfg_guidance_mode"] == "independent"
    assert values["t_schedule_mode"] == "linear"
    assert values["ref_normalize_db"] == -16.0
    assert values["decode_mode"] == "sequential"
    assert values["trim_tail"] is True
    assert values["seconds"] is None


def test_explicit_null_turns_nullable_parameters_off() -> None:
    values = _resolve({"ref_normalize_db": None, "speaker_kv_min_t": None})
    assert values["ref_normalize_db"] is None
    assert values["speaker_kv_min_t"] is None


@pytest.mark.parametrize(
    ("provided", "name", "reason"),
    [
        ({"nope": 1}, "nope", "unknown"),
        ({"num_steps": None}, "num_steps", "required"),
        ({"num_steps": 0}, "num_steps", "below_minimum"),
        ({"num_steps": 121}, "num_steps", "above_maximum"),
        ({"num_steps": 2.5}, "num_steps", "type"),
        ({"num_steps": True}, "num_steps", "type"),
        ({"trim_tail": 1}, "trim_tail", "type"),
        ({"decode_mode": "turbo"}, "decode_mode", "choice"),
        ({"seconds": 31.0}, "seconds", "above_maximum"),
        ({"seed": -1}, "seed", "below_minimum"),
        ({"seed": 2**53}, "seed", "above_maximum"),
        ({"cfg_scale_text": float("nan")}, "cfg_scale_text", "type"),
        ({"rescale_k": 1.0}, "rescale_sigma", "requires_pair"),
        ({"cfg_min_t": 0.9, "cfg_max_t": 0.5}, "cfg_min_t", "above_cfg_max_t"),
    ],
)
def test_invalid_values(provided: dict, name: str, reason: str) -> None:
    with pytest.raises(params.ParamError) as caught:
        _resolve(provided)
    assert (caught.value.name, caught.value.reason) == (name, reason)


def test_integral_floats_are_accepted_for_ints() -> None:
    assert _resolve({"num_steps": 12.0})["num_steps"] == 12


def test_joint_guidance_needs_equal_enabled_scales() -> None:
    # Text only: speaker and caption are not in play, so the scales cannot conflict.
    assert _resolve({"cfg_guidance_mode": "joint"})["cfg_guidance_mode"] == "joint"
    with pytest.raises(params.ParamError) as caught:
        _resolve({"cfg_guidance_mode": "joint"}, has_caption=True)
    assert caught.value.reason == "joint_requires_equal_scales"
    equal = {"cfg_guidance_mode": "joint", "cfg_scale_text": 4.0, "cfg_scale_caption": 4.0}
    assert _resolve(equal, has_caption=True)["cfg_scale_text"] == 4.0
    # The deprecated shared override makes them equal upstream.
    assert _resolve({"cfg_guidance_mode": "joint", "cfg_scale": 3.0}, has_caption=True)


def test_schema_describes_the_panel() -> None:
    schema = {entry["name"]: entry for entry in params.schema(CAPS)}
    assert set(schema) == params.NAMES
    assert schema["seconds"]["max"] == CAPS.max_output_seconds
    assert schema["max_ref_seconds"]["max"] == CAPS.max_ref_seconds
    assert schema["sway_coeff"]["visible_when"] == {"t_schedule_mode": ["sway"]}
    assert schema["decode_mode"]["choices"] == ["sequential", "batch"]
    assert {entry["tier"] for entry in schema.values()} == {"simple", "advanced"}


def test_capabilities_hide_parameters() -> None:
    no_caption = replace(CAPS, caption=False)
    names = {entry["name"] for entry in params.schema(no_caption)}
    assert "cfg_scale_caption" not in names and "max_caption_len" not in names
    assert "cfg_scale_caption" not in params.resolve(
        {}, no_caption, reference_kind="none", has_caption=False
    )

    meanflow = replace(
        CAPS, sampling="meanflow", ignores=("cfg", "sway"), param_defaults={"num_steps": 4}
    )
    schema = {entry["name"]: entry for entry in params.schema(meanflow)}
    assert not any(name.startswith("cfg_") for name in schema)
    assert "t_schedule_mode" not in schema and "sway_coeff" not in schema
    assert schema["num_steps"]["default"] == 4
    assert params.resolve({}, meanflow, reference_kind="none", has_caption=False)["num_steps"] == 4
