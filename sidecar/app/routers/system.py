"""System router: GET /health, GET /system (docs/api-spec.md)."""

from __future__ import annotations

from fastapi import APIRouter, Request

from app.schemas import HealthResponse, SystemInfo
from app.services.system_info import build_system_info

router = APIRouter()


@router.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse()


@router.get("/system", response_model=SystemInfo)
def system(request: Request) -> SystemInfo:
    return build_system_info(request.app.state.config)
