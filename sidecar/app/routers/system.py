"""System router: health, system info with memory, cache clearing, and the runtime's
package licenses (docs/api-spec.md)."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Response

from app.errors import ErrorCode
from app.routers.deps import services
from app.schemas import HealthResponse, PackageLicense, SystemInfo
from app.services.container import Services
from app.services.licenses import installed_packages
from app.services.system_info import build_system_info, clear_accelerator_cache

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
        # A GPU failure after the model loaded is its own issue; anything else failed the load.
        lost = status.error_code == ErrorCode.DEVICE_LOST.value
        info.issues.append(
            ErrorCode.DEVICE_LOST.value if lost else ErrorCode.MODEL_LOAD_FAILED.value
        )
    return info


@router.post("/system/cache/clear", status_code=204)
def clear_cache() -> Response:
    """Free accelerator memory torch keeps cached (the model itself stays loaded)."""
    clear_accelerator_cache()
    return Response(status_code=204)


@router.get("/system/licenses", response_model=list[PackageLicense])
def licenses() -> list[PackageLicense]:
    """Every Python package installed in the runtime, with its license."""
    return installed_packages()
