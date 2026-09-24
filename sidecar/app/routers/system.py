"""System router: GET /health, GET /system (docs/api-spec.md)."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends

from app.errors import ErrorCode
from app.routers.deps import services
from app.schemas import HealthResponse, SystemInfo
from app.services.container import Services
from app.services.system_info import build_system_info

router = APIRouter()

ServicesDep = Annotated[Services, Depends(services)]


@router.get("/health", response_model=HealthResponse)
def health(svc: ServicesDep) -> HealthResponse:
    """Liveness plus the engine state; the app shows `loading_model` until `ready`."""
    return HealthResponse(engine=svc.host.status())


@router.get("/system", response_model=SystemInfo)
def system(svc: ServicesDep) -> SystemInfo:
    info = build_system_info(svc.config)
    status = svc.host.status()
    info.queue_length = len(svc.queue)
    if status.state == "ready":
        info.active_model = status.model_id
        info.watermark_available = svc.host.watermark_ready
        if info.watermark_available is False:
            info.issues.append(ErrorCode.WATERMARK_UNAVAILABLE.value)
    elif status.state == "error":
        info.issues.append(ErrorCode.MODEL_LOAD_FAILED.value)
    return info
