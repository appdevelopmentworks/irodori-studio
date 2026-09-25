"""The single parameter table (D26): every per-request inference parameter with its type,
HF Space default, range, UI group and tier, the capabilities it needs, and when the UI
shows it. It feeds request validation (`resolve`), `GET /models/active/capabilities`
(`schema`) and, through that endpoint, the frontend parameter panel (D5).

Names are identical to upstream `SamplingRequest` fields, so the adapter passes resolved
values through unchanged (tests/test_params.py checks the names against the pinned
upstream source). Runtime options that need a model reload (device, precision, compile)
are not per-request parameters and live in `engine/base.py::RuntimeOptions`.
"""

from __future__ import annotations

import math
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Literal

from app.engine.registry import Capabilities

ParamType = Literal["int", "float", "bool", "enum"]
Group = Literal["sampling", "duration", "cfg", "speaker", "reference", "advanced"]
Tier = Literal["simple", "advanced"]

# `ReferenceInput.kind` values (schemas.py) that condition on a speaker / on audio clips.
SPEAKER_REFERENCES = ("voice", "clips", "embedding")
AUDIO_REFERENCES = ("voice", "clips")
EMBEDDING_REFERENCES = ("voice", "embedding")

# Seeds travel as JSON numbers to the WebView: stay within Number.MAX_SAFE_INTEGER so a
# stored seed reproduces exactly (decisions.md, S2).
MAX_SEED = 2**53 - 1
MAX_CANDIDATES = 32


@dataclass(frozen=True)
class ParamSpec:
    name: str
    type: ParamType
    default: object
    group: Group
    tier: Tier = "advanced"
    # `None` is a valid value meaning "auto" / "off" (e.g. seed, seconds, ref_normalize_db).
    nullable: bool = False
    # Bounds are numbers, or the name of a `Capabilities` attribute (model-dependent).
    minimum: float | str | None = None
    maximum: float | str | None = None
    step: float | None = None
    choices: tuple[str, ...] = ()
    # Capability flags that must all be true for the parameter to exist for a model.
    requires: tuple[str, ...] = ()
    # Hidden (and not sent upstream) when the model `ignores` any of these tags.
    tags: tuple[str, ...] = ()
    # UI hint: visible when each key's current value is one of the listed values. Keys are
    # other parameter names, or "reference" for the request's reference kind.
    visible_when: tuple[tuple[str, tuple[object, ...]], ...] = ()


_SPEAKER_ONLY = (("reference", SPEAKER_REFERENCES),)
_AUDIO_ONLY = (("reference", AUDIO_REFERENCES),)
_TAIL = (("trim_tail", (True,)),)

PARAMS: tuple[ParamSpec, ...] = (
    # --- Sampling ------------------------------------------------------------------
    ParamSpec("num_steps", "int", 40, "sampling", minimum=1, maximum=120, step=1),
    ParamSpec(
        "num_candidates",
        "int",
        1,
        "sampling",
        tier="simple",
        minimum=1,
        maximum=MAX_CANDIDATES,
        step=1,
    ),
    ParamSpec(
        "seed",
        "int",
        None,
        "sampling",
        tier="simple",
        nullable=True,
        minimum=0,
        maximum=MAX_SEED,
        step=1,
    ),
    ParamSpec(
        "t_schedule_mode",
        "enum",
        "linear",
        "sampling",
        choices=("linear", "sway"),
        tags=("sway",),
    ),
    ParamSpec(
        "sway_coeff",
        "float",
        -1.0,
        "sampling",
        minimum=-1.0,
        maximum=1.5,
        step=0.1,
        tags=("sway",),
        visible_when=(("t_schedule_mode", ("sway",)),),
    ),
    ParamSpec(
        "truncation_factor",
        "float",
        None,
        "sampling",
        nullable=True,
        minimum=0.05,
        maximum=2.0,
        step=0.01,
    ),
    ParamSpec(
        "rescale_k",
        "float",
        None,
        "sampling",
        nullable=True,
        minimum=0.01,
        maximum=10.0,
        step=0.01,
    ),
    ParamSpec(
        "rescale_sigma",
        "float",
        None,
        "sampling",
        nullable=True,
        minimum=0.01,
        maximum=10.0,
        step=0.01,
    ),
    ParamSpec("context_kv_cache", "bool", True, "sampling"),
    # --- Duration ------------------------------------------------------------------
    ParamSpec(
        "seconds",
        "float",
        None,
        "duration",
        nullable=True,
        minimum=0.5,
        maximum="max_output_seconds",
        step=0.1,
    ),
    ParamSpec(
        "duration_scale",
        "float",
        1.0,
        "duration",
        minimum=0.5,
        maximum=1.5,
        step=0.01,
        requires=("duration_predictor",),
    ),
    # --- Classifier-free guidance --------------------------------------------------
    ParamSpec(
        "cfg_guidance_mode",
        "enum",
        "independent",
        "cfg",
        choices=("independent", "joint", "alternating"),
        tags=("cfg",),
    ),
    ParamSpec(
        "cfg_scale_text",
        "float",
        3.0,
        "cfg",
        minimum=0.0,
        maximum=10.0,
        step=0.1,
        tags=("cfg",),
    ),
    # Space default 4.0; the CLI/runtime default is 3.0 (D26).
    ParamSpec(
        "cfg_scale_caption",
        "float",
        4.0,
        "cfg",
        minimum=0.0,
        maximum=10.0,
        step=0.1,
        requires=("caption",),
        tags=("cfg",),
    ),
    ParamSpec(
        "cfg_scale_speaker",
        "float",
        5.0,
        "cfg",
        minimum=0.0,
        maximum=10.0,
        step=0.1,
        requires=("speaker",),
        tags=("cfg",),
        visible_when=_SPEAKER_ONLY,
    ),
    # Deprecated shared override of every enabled scale (kept for Space parity).
    ParamSpec(
        "cfg_scale",
        "float",
        None,
        "cfg",
        nullable=True,
        minimum=0.0,
        maximum=10.0,
        step=0.1,
        tags=("cfg",),
    ),
    ParamSpec(
        "cfg_min_t",
        "float",
        0.5,
        "cfg",
        minimum=0.0,
        maximum=1.0,
        step=0.01,
        tags=("cfg",),
    ),
    ParamSpec(
        "cfg_max_t",
        "float",
        1.0,
        "cfg",
        minimum=0.0,
        maximum=1.0,
        step=0.01,
        tags=("cfg",),
    ),
    # --- Speaker ---------------------------------------------------------------------
    ParamSpec(
        "speaker_kv_scale",
        "float",
        None,
        "speaker",
        nullable=True,
        minimum=0.1,
        maximum=5.0,
        step=0.05,
        requires=("speaker",),
        tags=("speaker_kv",),
        visible_when=_SPEAKER_ONLY,
    ),
    ParamSpec(
        "speaker_kv_min_t",
        "float",
        0.9,
        "speaker",
        nullable=True,
        minimum=0.0,
        maximum=1.0,
        step=0.01,
        requires=("speaker",),
        tags=("speaker_kv",),
        visible_when=_SPEAKER_ONLY,
    ),
    ParamSpec(
        "speaker_kv_max_layers",
        "int",
        None,
        "speaker",
        nullable=True,
        minimum=0,
        maximum=64,
        step=1,
        requires=("speaker",),
        tags=("speaker_kv",),
        visible_when=_SPEAKER_ONLY,
    ),
    ParamSpec(
        "speaker_uncond_mode",
        "enum",
        "mask",
        "speaker",
        choices=("mask", "noise"),
        requires=("speaker_embedding",),
        visible_when=(("reference", EMBEDDING_REFERENCES),),
    ),
    # --- Reference audio -----------------------------------------------------------
    ParamSpec(
        "ref_normalize_db",
        "float",
        -16.0,
        "reference",
        nullable=True,
        minimum=-40.0,
        maximum=0.0,
        step=0.5,
        requires=("speaker_reference",),
        visible_when=_AUDIO_ONLY,
    ),
    ParamSpec(
        "ref_ensure_max",
        "bool",
        True,
        "reference",
        requires=("speaker_reference",),
        visible_when=_AUDIO_ONLY,
    ),
    # None = the checkpoint's recommendation (capabilities.max_ref_seconds).
    ParamSpec(
        "max_ref_seconds",
        "float",
        None,
        "reference",
        nullable=True,
        minimum=1.0,
        maximum="max_ref_seconds",
        step=1.0,
        requires=("speaker_reference",),
        visible_when=_AUDIO_ONLY,
    ),
    # --- Advanced --------------------------------------------------------------------
    ParamSpec(
        "max_text_len",
        "int",
        None,
        "advanced",
        nullable=True,
        minimum=16,
        maximum=1024,
        step=1,
    ),
    ParamSpec(
        "max_caption_len",
        "int",
        None,
        "advanced",
        nullable=True,
        minimum=16,
        maximum=1024,
        step=1,
        requires=("caption",),
    ),
    ParamSpec(
        "decode_mode",
        "enum",
        "sequential",
        "advanced",
        choices=("sequential", "batch"),
    ),
    ParamSpec("trim_tail", "bool", True, "advanced"),
    ParamSpec(
        "tail_window_size",
        "int",
        20,
        "advanced",
        minimum=1,
        maximum=200,
        step=1,
        visible_when=_TAIL,
    ),
    ParamSpec(
        "tail_std_threshold",
        "float",
        0.05,
        "advanced",
        minimum=0.001,
        maximum=1.0,
        step=0.001,
        visible_when=_TAIL,
    ),
    ParamSpec(
        "tail_mean_threshold",
        "float",
        0.1,
        "advanced",
        minimum=0.001,
        maximum=1.0,
        step=0.001,
        visible_when=_TAIL,
    ),
)

NAMES = frozenset(spec.name for spec in PARAMS)
_BY_NAME = {spec.name: spec for spec in PARAMS}


class ParamError(ValueError):
    """An invalid parameter; `reason` is a stable code for the API error detail."""

    def __init__(self, name: str, reason: str) -> None:
        super().__init__(f"{name}: {reason}")
        self.name = name
        self.reason = reason


def applicable(spec: ParamSpec, caps: Capabilities) -> bool:
    if not all(bool(getattr(caps, flag)) for flag in spec.requires):
        return False
    return not set(spec.tags) & set(caps.ignores)


def default_for(spec: ParamSpec, caps: Capabilities) -> object:
    return caps.param_defaults.get(spec.name, spec.default)


def bounds(name: str, caps: Capabilities) -> tuple[float | None, float | None] | None:
    """(minimum, maximum) of a parameter for a model, or None when it does not apply."""
    spec = next((spec for spec in PARAMS if spec.name == name), None)
    if spec is None or not applicable(spec, caps):
        return None
    return _bound(spec.minimum, caps), _bound(spec.maximum, caps)


def schema(caps: Capabilities) -> list[dict[str, object]]:
    """The parameter schema the UI renders for a model (GET /models/active/capabilities)."""
    return [
        {
            "name": spec.name,
            "type": spec.type,
            "default": default_for(spec, caps),
            "nullable": spec.nullable,
            "min": _bound(spec.minimum, caps),
            "max": _bound(spec.maximum, caps),
            "step": spec.step,
            "choices": list(spec.choices) or None,
            "group": spec.group,
            "tier": spec.tier,
            "visible_when": {key: list(values) for key, values in spec.visible_when} or None,
        }
        for spec in PARAMS
        if applicable(spec, caps)
    ]


def resolve(
    provided: Mapping[str, object],
    caps: Capabilities,
    *,
    reference_kind: str,
    has_caption: bool,
) -> dict[str, object]:
    """Validate explicitly provided values and fill in defaults.

    `provided` holds only the keys the client sent (an explicit `None` means auto/off for
    nullable parameters). Parameters the model does not support are dropped. Returns the
    complete set of applicable parameters, keyed by upstream `SamplingRequest` field.
    """
    for name in provided:
        if name not in NAMES:
            raise ParamError(name, "unknown")
    values: dict[str, object] = {}
    for spec in PARAMS:
        if not applicable(spec, caps):
            continue
        raw = provided[spec.name] if spec.name in provided else default_for(spec, caps)
        values[spec.name] = _coerce(spec, raw, caps)
    _check_combinations(values, caps, reference_kind=reference_kind, has_caption=has_caption)
    return values


def _bound(value: float | str | None, caps: Capabilities) -> float | None:
    if isinstance(value, str):
        return float(getattr(caps, value))
    return value


def _coerce(spec: ParamSpec, value: object, caps: Capabilities) -> object:
    if value is None:
        if spec.nullable:
            return None
        raise ParamError(spec.name, "required")
    if spec.type == "bool":
        if not isinstance(value, bool):
            raise ParamError(spec.name, "type")
        return value
    if spec.type == "enum":
        if not isinstance(value, str) or value not in spec.choices:
            raise ParamError(spec.name, "choice")
        return value
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ParamError(spec.name, "type")
    if spec.type == "int":
        if isinstance(value, float):
            if not value.is_integer():
                raise ParamError(spec.name, "type")
            value = int(value)
    else:
        value = float(value)
        if not math.isfinite(value):
            raise ParamError(spec.name, "type")
    minimum = _bound(spec.minimum, caps)
    maximum = _bound(spec.maximum, caps)
    if minimum is not None and value < minimum:
        raise ParamError(spec.name, "below_minimum")
    if maximum is not None and value > maximum:
        raise ParamError(spec.name, "above_maximum")
    return value


def _check_combinations(
    values: dict[str, object],
    caps: Capabilities,
    *,
    reference_kind: str,
    has_caption: bool,
) -> None:
    if "rescale_k" in values and (values["rescale_k"] is None) != (values["rescale_sigma"] is None):
        name = "rescale_sigma" if values["rescale_sigma"] is None else "rescale_k"
        raise ParamError(name, "requires_pair")
    if "cfg_min_t" in values and values["cfg_min_t"] > values["cfg_max_t"]:  # type: ignore[operator]
        raise ParamError("cfg_min_t", "above_cfg_max_t")
    # Upstream rejects `joint` guidance unless every enabled scale is equal; check it here
    # so the client gets a parameter error instead of a failed job.
    if values.get("cfg_guidance_mode") == "joint" and values.get("cfg_scale") is None:
        enabled = [values["cfg_scale_text"]]
        if caps.speaker and reference_kind in SPEAKER_REFERENCES:
            enabled.append(values["cfg_scale_speaker"])
        if caps.caption and has_caption:
            enabled.append(values["cfg_scale_caption"])
        enabled = [float(v) for v in enabled if float(v) > 0.0]  # type: ignore[arg-type]
        if enabled and max(enabled) - min(enabled) > 1e-6:
            raise ParamError("cfg_guidance_mode", "joint_requires_equal_scales")
