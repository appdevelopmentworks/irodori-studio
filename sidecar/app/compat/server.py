"""The external API app (D21): OpenAI-compatible routes under `/v1`, VOICEVOX-compatible
routes at the root, served by a second listener in the sidecar and sharing its services
(one resident model, one synthesis queue).

Every request is logged for the API Server screen. When an API key is set (always for a
LAN bind) each request needs it, as `Authorization: Bearer <key>` or `X-API-Key: <key>`.
"""

from __future__ import annotations

import hmac
import time
from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING

from fastapi import FastAPI, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.compat import openai, voicevox
from app.errors import ApiError
from app.schemas import ApiRequestLog
from app.services.job_manager import now_iso

if TYPE_CHECKING:
    from app.services.api_server import ApiServerManager
    from app.services.container import Services

# Web pages may call the API from this computer only (like VOICEVOX's default policy).
LOCAL_ORIGINS = r"^(https?://(localhost|127\.0\.0\.1|\[::1\])(:\d+)?|app://.*)$"


def family(path: str) -> str:
    if path.startswith("/v1/") or path == "/v1":
        return "openai"
    if path.lstrip("/").split("/", 1)[0] in _VOICEVOX_ROOTS:
        return "voicevox"
    return "other"


_VOICEVOX_ROOTS = frozenset(
    {
        "speakers", "speaker_info", "initialize_speaker", "is_initialized_speaker",
        "audio_query", "accent_phrases", "synthesis", "cancellable_synthesis",
        "multi_synthesis", "connect_waves", "version", "core_versions", "engine_manifest",
        "supported_devices", "presets", "user_dict", "singers", "_resources",
    }
)  # fmt: skip


def create_external_app(services: Services, manager: ApiServerManager) -> FastAPI:
    app = FastAPI(
        title="irodori-studio API",
        version=services.config.app_version,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    app.state.services = services
    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=LOCAL_ORIGINS,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.middleware("http")
    async def guard(
        request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        started = time.perf_counter()
        path = request.url.path
        kind = family(path)
        key = manager.api_key()
        if key and request.method != "OPTIONS" and not _authorized(request, key):
            response: Response = _unauthorized(kind)
        else:
            response = await call_next(request)
        manager.record(
            ApiRequestLog(
                time=now_iso(),
                client=request.client.host if request.client else "",
                method=request.method,
                path=path,
                status=response.status_code,
                duration_ms=round((time.perf_counter() - started) * 1000),
                family=kind,  # type: ignore[arg-type]
            )
        )
        return response

    @app.exception_handler(openai.OpenAIError)
    async def _openai_error(_: Request, exc: openai.OpenAIError) -> JSONResponse:
        return openai.error_response(exc)

    @app.exception_handler(ApiError)
    async def _api_error(request: Request, exc: ApiError) -> JSONResponse:
        if family(request.url.path) == "openai":
            return openai.error_response(exc)
        status = exc.status_code if exc.status_code >= 400 else 400
        return JSONResponse(
            status_code=status, content={"detail": f"{exc.code.value}: {exc.message}"}
        )

    @app.exception_handler(RequestValidationError)
    async def _validation(request: Request, exc: RequestValidationError) -> JSONResponse:
        if family(request.url.path) == "openai":
            body = openai.error_body(str(exc.errors()), status=422, code="invalid_request")
            return JSONResponse(status_code=422, content=body)
        return JSONResponse(status_code=422, content={"detail": exc.errors()})

    app.include_router(openai.router)
    app.include_router(voicevox.router)
    return app


def _authorized(request: Request, key: str) -> bool:
    header = request.headers.get("authorization", "")
    token = (
        header[7:].strip() if header[:7].lower() == "bearer " else request.headers.get("x-api-key")
    )
    return token is not None and hmac.compare_digest(token.encode(), key.encode())


def _unauthorized(kind: str) -> JSONResponse:
    if kind == "openai":
        body = openai.error_body("Invalid API key.", status=401, code="invalid_api_key")
        return JSONResponse(status_code=401, content=body)
    return JSONResponse(status_code=401, content={"detail": "Invalid API key."})
