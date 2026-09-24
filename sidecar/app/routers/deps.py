"""Shared router dependencies."""

from __future__ import annotations

from fastapi import Request

from app.services.container import Services


def services(request: Request) -> Services:
    return request.app.state.services
