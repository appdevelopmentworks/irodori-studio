"""Models router: registry entries, the active model's parameter schema (D5, D26) and the
emoji palette."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends

from app.engine import irodori_adapter, params
from app.engine.base import BackendError
from app.engine.registry import ModelSpec
from app.errors import ApiError, ErrorCode
from app.routers.deps import services
from app.schemas import (
    Capabilities,
    EmojiItem,
    Limits,
    ModelCapabilities,
    ModelInfo,
    ParamSchema,
)
from app.services import clips, synthesis
from app.services.container import Services

router = APIRouter()

ServicesDep = Annotated[Services, Depends(services)]


def _capabilities(spec: ModelSpec) -> Capabilities:
    caps = spec.capabilities
    return Capabilities(
        caption=caps.caption,
        speaker_reference=caps.speaker_reference,
        speaker_embedding=caps.speaker_embedding,
        lora=caps.lora,
        duration_predictor=caps.duration_predictor,
        max_ref_seconds=caps.max_ref_seconds,
        max_output_seconds=caps.max_output_seconds,
        sampling=caps.sampling,  # type: ignore[arg-type]
        ignores=list(caps.ignores),
    )


@router.get("/models", response_model=list[ModelInfo])
def list_models(svc: ServicesDep) -> list[ModelInfo]:
    active = svc.host.spec.id
    return [
        ModelInfo(
            id=spec.id,
            display_name=spec.display_name,
            tier=spec.tier,
            size_bytes_approx=spec.size_bytes_approx,
            installed=svc.host.installed(spec),
            active=spec.id == active,
            capabilities=_capabilities(spec),
        )
        for spec in svc.registry.models
    ]


@router.get("/models/active/capabilities", response_model=ModelCapabilities)
def active_capabilities(svc: ServicesDep) -> ModelCapabilities:
    """Everything the UI needs to render the parameter panel for the active model."""
    spec = svc.host.spec
    return ModelCapabilities(
        model_id=spec.id,
        display_name=spec.display_name,
        capabilities=_capabilities(spec),
        params=[ParamSchema(**entry) for entry in params.schema(spec.capabilities)],
        limits=Limits(
            max_candidates=params.MAX_CANDIDATES,
            max_text_chars=synthesis.MAX_TEXT_CHARS,
            max_caption_chars=synthesis.MAX_CAPTION_CHARS,
            max_clips=clips.MAX_VOICE_CLIPS,
            max_clip_seconds=clips.MAX_CLIP_SECONDS,
            max_upload_bytes=clips.MAX_UPLOAD_BYTES,
        ),
    )


@router.get("/emoji", response_model=list[EmojiItem])
def emoji() -> list[EmojiItem]:
    """Upstream's emoji palette; labels are Japanese source data, localized by the UI via
    `key` (D17)."""
    try:
        entries = irodori_adapter.emoji_palette()
    except (BackendError, OSError, SyntaxError, ValueError) as exc:
        raise ApiError(ErrorCode.UPSTREAM_UNAVAILABLE, str(exc), status_code=503) from exc
    return [
        EmojiItem(
            symbol=entry.symbol,
            key="u" + "_".join(f"{ord(char):x}" for char in entry.symbol),
            label_ja=entry.label,
            description_ja=entry.description,
        )
        for entry in entries
    ]
