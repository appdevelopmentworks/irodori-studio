"""Projects router: a narration or a script saved as one `.iroproj` file and opened
again with its adopted takes (D23)."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends

from app.routers.deps import services
from app.schemas import ExportedFile, ProjectOpened, ProjectOpenRequest, ProjectSaveRequest
from app.services.container import Services

router = APIRouter()

ServicesDep = Annotated[Services, Depends(services)]


@router.post("/projects/save", response_model=ExportedFile)
def save_project(body: ProjectSaveRequest, svc: ServicesDep) -> ExportedFile:
    return svc.projects.save(body)


@router.post("/projects/open", response_model=ProjectOpened, status_code=201)
def open_project(body: ProjectOpenRequest, svc: ServicesDep) -> ProjectOpened:
    """A new narration or script from the project file."""
    return svc.projects.open(body)
