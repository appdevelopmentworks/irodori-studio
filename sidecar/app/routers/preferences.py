"""Preferences router: sidecar-side settings applied per request (watermark D12, history
limits D23)."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends

from app.routers.deps import services
from app.schemas import Preferences, PreferencesPatch
from app.services.container import Services

router = APIRouter()

ServicesDep = Annotated[Services, Depends(services)]


@router.get("/preferences", response_model=Preferences)
def get_preferences(svc: ServicesDep) -> Preferences:
    return svc.preferences.get()


@router.patch("/preferences", response_model=Preferences)
def update_preferences(body: PreferencesPatch, svc: ServicesDep) -> Preferences:
    updated = svc.preferences.update(body)
    svc.history.prune(updated)
    return updated
