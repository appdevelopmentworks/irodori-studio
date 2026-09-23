"""Pydantic request/response models mirroring docs/api-spec.md.

Keep in sync with the spec and with src/lib/types.ts in the same change.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel

Device = Literal["cuda", "mps", "cpu"]
Precision = Literal["fp32", "bf16"]


class ErrorResponse(BaseModel):
    code: str
    message: str
    detail: dict[str, object] = {}


class HealthResponse(BaseModel):
    status: Literal["ok"] = "ok"


class TorchInfo(BaseModel):
    version: str
    cuda_version: str | None = None
    cuda_available: bool
    mps_available: bool


class DeviceInfo(BaseModel):
    kind: Device
    precision: Precision
    available: bool
    name: str | None = None
    compute_capability: str | None = None
    memory_total_mb: int | None = None
    memory_used_mb: int | None = None


class SystemInfo(BaseModel):
    app_version: str
    python_version: str
    platform: Literal["windows", "macos", "linux", "other"]
    device: DeviceInfo
    torch: TorchInfo | None = None
    upstream_commit: str | None = None
    active_model: str | None = None
    queue_length: int = 0
    watermark_available: bool | None = None
    issues: list[str] = []
