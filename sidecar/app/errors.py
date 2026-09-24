"""Stable error and issue codes, returned as `{code, message, detail}` (docs/api-spec.md).

The frontend translates codes (src/lib/errors.ts); `message` is a developer-facing
English hint, never shown as UI copy (D17). Job failures reuse the same codes in the
SSE `failed` event.
"""

from __future__ import annotations

import logging
from enum import Enum

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from app.schemas import ErrorResponse

log = logging.getLogger("irodori.api")


class ErrorCode(str, Enum):
    INTERNAL_ERROR = "internal_error"
    # System issues reported by GET /system (`issues`).
    TORCH_UNAVAILABLE = "torch_unavailable"
    CUDA_UNAVAILABLE = "cuda_unavailable"
    MPS_UNAVAILABLE = "mps_unavailable"
    WATERMARK_UNAVAILABLE = "watermark_unavailable"
    # Engine / model (D4).
    MODEL_LOAD_FAILED = "model_load_failed"
    MODEL_FILES_MISSING = "model_files_missing"
    MODEL_NOT_LOADED = "model_not_loaded"
    UPSTREAM_INCOMPATIBLE = "upstream_incompatible"
    UPSTREAM_UNAVAILABLE = "upstream_unavailable"
    # Request validation.
    INVALID_REQUEST = "invalid_request"
    INVALID_PARAMS = "invalid_params"
    TEXT_EMPTY = "text_empty"
    TEXT_TOO_LONG = "text_too_long"
    CAPTION_UNSUPPORTED = "caption_unsupported"
    REFERENCE_UNSUPPORTED = "reference_unsupported"
    LORA_UNSUPPORTED = "lora_unsupported"
    LORA_NOT_FOUND = "lora_not_found"
    LORA_INCOMPATIBLE_WITH_COMPILE = "lora_incompatible_with_compile"
    EMBEDDING_NOT_FOUND = "embedding_not_found"
    VOICE_NOT_FOUND = "voice_not_found"
    # Reference clips.
    CLIP_NOT_FOUND = "clip_not_found"
    CLIP_FORMAT_UNSUPPORTED = "clip_format_unsupported"
    CLIP_DECODE_FAILED = "clip_decode_failed"
    CLIP_EMPTY = "clip_empty"
    CLIP_TOO_SHORT = "clip_too_short"
    CLIP_TOO_LONG = "clip_too_long"
    CLIP_TOO_LARGE = "clip_too_large"
    CLIP_RANGE_INVALID = "clip_range_invalid"
    CLIP_IN_USE = "clip_in_use"
    # Voices (Session 4).
    VOICE_INVALID = "voice_invalid"
    CONSENT_REQUIRED = "consent_required"
    EMBEDDING_INVALID = "embedding_invalid"
    PACKAGE_INVALID = "package_invalid"
    # Text and narration (Session 5).
    DICTIONARY_INVALID = "dictionary_invalid"
    SUBTITLE_INVALID = "subtitle_invalid"
    NARRATION_NOT_FOUND = "narration_not_found"
    CHUNK_NOT_FOUND = "chunk_not_found"
    NARRATION_BUSY = "narration_busy"
    NARRATION_INCOMPLETE = "narration_incomplete"
    # Jobs and stored results.
    JOB_NOT_FOUND = "job_not_found"
    AUDIO_NOT_FOUND = "audio_not_found"
    HISTORY_NOT_FOUND = "history_not_found"
    SYNTHESIS_FAILED = "synthesis_failed"
    OUT_OF_MEMORY = "out_of_memory"
    SAVE_PATH_INVALID = "save_path_invalid"
    SAVE_FAILED = "save_failed"
    FFMPEG_UNAVAILABLE = "ffmpeg_unavailable"

    @classmethod
    def parse(cls, value: str) -> ErrorCode:
        try:
            return cls(value)
        except ValueError:
            return cls.INTERNAL_ERROR


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


def not_found(code: ErrorCode, what: str) -> ApiError:
    return ApiError(code, f"{what} not found", status_code=404)


def register_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(ApiError)
    async def _api_error(_: Request, exc: ApiError) -> JSONResponse:
        body = ErrorResponse(code=exc.code.value, message=exc.message, detail=exc.detail)
        return JSONResponse(status_code=exc.status_code, content=body.model_dump())

    @app.exception_handler(RequestValidationError)
    async def _validation_error(_: Request, exc: RequestValidationError) -> JSONResponse:
        errors = [
            {"loc": [str(part) for part in error.get("loc", ())], "type": error.get("type")}
            for error in exc.errors()
        ]
        body = ErrorResponse(
            code=ErrorCode.INVALID_REQUEST.value,
            message="request validation failed",
            detail={"errors": errors},
        )
        return JSONResponse(status_code=422, content=body.model_dump())

    @app.exception_handler(Exception)
    async def _unexpected(_: Request, exc: Exception) -> JSONResponse:
        log.exception("unhandled error", exc_info=exc)
        body = ErrorResponse(code=ErrorCode.INTERNAL_ERROR.value, message=type(exc).__name__)
        return JSONResponse(status_code=500, content=body.model_dump())
