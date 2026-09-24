"""TTS router: POST /tts/generate -> 202 job (D10, D24)."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends

from app.routers.deps import services
from app.schemas import JobAccepted, SynthesisRequest
from app.services.container import Services

router = APIRouter()

ServicesDep = Annotated[Services, Depends(services)]


@router.post("/tts/generate", response_model=JobAccepted, status_code=202)
def generate(body: SynthesisRequest, svc: ServicesDep) -> JobAccepted:
    job, position = svc.synthesis.submit(body, source="ui")
    return JobAccepted(job_id=job.id, queue_position=position)
