"""API Server router: configure and watch the external listener (D21) from the app."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends

from app.compat import voicevox
from app.errors import ApiError, ErrorCode
from app.routers.deps import services
from app.schemas import ApiServerConfig, ApiServerStatus, ApiStyle
from app.services.container import Services

router = APIRouter()

ServicesDep = Annotated[Services, Depends(services)]


@router.get("/api-server/config", response_model=ApiServerConfig)
def get_config(svc: ServicesDep) -> ApiServerConfig:
    return svc.api_server.config


@router.put("/api-server/config", response_model=ApiServerStatus)
async def put_config(body: ApiServerConfig, svc: ServicesDep) -> ApiServerStatus:
    """Save and apply: start, restart or stop the listener. A LAN bind needs a key."""
    if body.bind == "lan" and not body.api_key:
        raise ApiError(ErrorCode.API_KEY_REQUIRED, "a LAN bind needs an API key", status_code=422)
    return await svc.api_server.configure(body)


@router.get("/api-server/status", response_model=ApiServerStatus)
def get_status(svc: ServicesDep) -> ApiServerStatus:
    """Running or not, the URLs, and the last requests (newest first)."""
    return svc.api_server.status()


@router.get("/api-server/styles", response_model=list[ApiStyle])
def get_styles(svc: ServicesDep) -> list[ApiStyle]:
    """The VOICEVOX speakers and styles the listener offers, with their ids."""
    return voicevox.styles(svc)
