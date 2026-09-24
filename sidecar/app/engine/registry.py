"""Model registry (D5): `sidecar/models.json` -> `ModelSpec`s with capabilities.

Nothing outside this module and `models.json` names a model. Adding a model (e.g. the
forthcoming Large) is one registry entry plus a submodule bump; the parameter schema and
the UI follow its capabilities (`engine/params.py`).
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

from app.config import MODELS_JSON


@dataclass(frozen=True)
class Capabilities:
    caption: bool
    speaker_reference: bool
    speaker_embedding: bool
    lora: bool
    duration_predictor: bool
    max_ref_seconds: float
    max_output_seconds: float
    # "rf" or "meanflow" (D5: MeanFlow is not offered, but the format can express it).
    sampling: str
    # Parameter tags this model ignores (e.g. "cfg", "sway"); matching controls are hidden.
    ignores: tuple[str, ...] = ()
    # Per-model overrides of the Space defaults in the parameter table (e.g. MeanFlow
    # would set {"num_steps": 4}).
    param_defaults: dict[str, object] = field(default_factory=dict)

    @property
    def speaker(self) -> bool:
        return self.speaker_reference or self.speaker_embedding


@dataclass(frozen=True)
class ModelSpec:
    id: str
    display_name: str
    hf_repo: str
    hf_revision: str
    codec_repo: str
    codec_revision: str
    size_bytes_approx: int
    tier: str
    capabilities: Capabilities
    requirements: dict[str, float] = field(default_factory=dict)


@dataclass(frozen=True)
class Registry:
    default_model: str
    models: tuple[ModelSpec, ...]

    def get(self, model_id: str) -> ModelSpec | None:
        return next((m for m in self.models if m.id == model_id), None)

    @property
    def default(self) -> ModelSpec:
        spec = self.get(self.default_model)
        if spec is None:
            raise ValueError(f"default_model {self.default_model!r} is not in the registry")
        return spec


def load_registry(path: Path = MODELS_JSON) -> Registry:
    raw = json.loads(path.read_text(encoding="utf-8"))
    if raw.get("schema") != 1:
        raise ValueError(f"unsupported models.json schema: {raw.get('schema')!r}")
    models = tuple(_model(entry) for entry in raw["models"])
    registry = Registry(default_model=str(raw["default_model"]), models=models)
    registry.default  # noqa: B018 - validates default_model
    return registry


def _model(entry: dict) -> ModelSpec:
    caps = entry["capabilities"]
    return ModelSpec(
        id=str(entry["id"]),
        display_name=str(entry["display_name"]),
        hf_repo=str(entry["hf_repo"]),
        hf_revision=str(entry["hf_revision"]),
        codec_repo=str(entry["codec_repo"]),
        codec_revision=str(entry["codec_revision"]),
        size_bytes_approx=int(entry.get("size_bytes_approx", 0)),
        tier=str(entry.get("tier", "default")),
        capabilities=Capabilities(
            caption=bool(caps["caption"]),
            speaker_reference=bool(caps["speaker_reference"]),
            speaker_embedding=bool(caps["speaker_embedding"]),
            lora=bool(caps["lora"]),
            duration_predictor=bool(caps["duration_predictor"]),
            max_ref_seconds=float(caps["max_ref_seconds"]),
            max_output_seconds=float(caps["max_output_seconds"]),
            sampling=str(caps["sampling"]),
            ignores=tuple(str(tag) for tag in caps.get("ignores", ())),
            param_defaults=dict(caps.get("param_defaults", {})),
        ),
        requirements={k: float(v) for k, v in entry.get("requirements", {}).items()},
    )
