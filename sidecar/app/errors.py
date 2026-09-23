"""Stable error and issue codes, returned as `{code, message, detail}` (docs/api-spec.md).

The frontend translates codes (src/lib/errors.ts); `message` is a developer-facing
English hint, never shown as UI copy (D17).
"""

from __future__ import annotations

from enum import Enum

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from app.schemas import ErrorResponse


class ErrorCode(str, Enum):
    INTERNAL_ERROR = "internal_error"
    # System issues reported by GET /system (`issues`).
    TORCH_UNAVAILABLE = "torch_unavailable"
    CUDA_UNAVAILABLE = "cuda_unavailable"
    MPS_UNAVAILABLE = "mps_unavailable"


class ApiError(Exception):
    def __init__(
        self,
        code: ErrorCode,
        message: str,
        *,
        status_code: int = 400,
        detail: dict[str, object] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code
        self.detail = detail or {}


def register_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(ApiError)
    async def _api_error(_: Request, exc: ApiError) -> JSONResponse:
        body = ErrorResponse(code=exc.code.value, message=exc.message, detail=exc.detail)
        return JSONResponse(status_code=exc.status_code, content=body.model_dump())
