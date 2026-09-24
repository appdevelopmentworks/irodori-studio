"""Presets router: named sets of sampling parameters (requirements §6.8)."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Response

from app.errors import ErrorCode, not_found
from app.routers.deps import services
from app.schemas import Preset, PresetInput, PresetPatch
from app.services.container import Services

router = APIRouter()

ServicesDep = Annotated[Services, Depends(services)]


@router.get("/presets", response_model=list[Preset])
def list_presets(svc: ServicesDep) -> list[Preset]:
    """By name."""
    return svc.presets.list()


@router.post("/presets", response_model=Preset, status_code=201)
def create_preset(body: PresetInput, svc: ServicesDep) -> Preset:
    return svc.presets.create(body)


@router.patch("/presets/{preset_id}", response_model=Preset)
def update_preset(preset_id: str, body: PresetPatch, svc: ServicesDep) -> Preset:
    return svc.presets.update(preset_id, body)


@router.delete("/presets/{preset_id}", status_code=204)
def delete_preset(preset_id: str, svc: ServicesDep) -> Response:
    if not svc.presets.delete(preset_id):
        raise not_found(ErrorCode.PRESET_NOT_FOUND, "preset")
    return Response(status_code=204)
