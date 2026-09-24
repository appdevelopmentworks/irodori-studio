"""Script router: multi-speaker dialogue parsed from text or CSV / TSV, rendered line by
line on the synthesis queue, exported as per-line files, a merged drama and subtitles
(requirements §6.7)."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Response

from app.errors import ErrorCode, not_found
from app.routers.deps import services
from app.schemas import (
    AssembledScript,
    ExportedFile,
    FileNames,
    FileNamesRequest,
    JobAccepted,
    LineInsert,
    LineMove,
    LinePatch,
    Script,
    ScriptCreate,
    ScriptExported,
    ScriptExportRequest,
    ScriptImport,
    ScriptPatch,
    ScriptRenderRequest,
    ScriptSummary,
    ScriptTableRequest,
)
from app.services.container import Services

router = APIRouter()

ServicesDep = Annotated[Services, Depends(services)]


@router.get("/scripts", response_model=list[ScriptSummary])
def list_scripts(svc: ServicesDep) -> list[ScriptSummary]:
    return svc.script.list()


@router.post("/scripts", response_model=Script, status_code=201)
def create_script(body: ScriptCreate, svc: ServicesDep) -> Script:
    """Parse "話者：セリフ" text or a CSV / TSV table into lines and keep them."""
    return svc.script.create(body)


@router.get("/scripts/{script_id}", response_model=Script)
def get_script(script_id: str, svc: ServicesDep) -> Script:
    return svc.script.require(script_id)


@router.patch("/scripts/{script_id}", response_model=Script)
def update_script(script_id: str, body: ScriptPatch, svc: ServicesDep) -> Script:
    """Title, settings, or the speaker → voice map."""
    return svc.script.update(script_id, body)


@router.delete("/scripts/{script_id}", status_code=204)
def delete_script(script_id: str, svc: ServicesDep) -> Response:
    if not svc.script.delete(script_id):
        raise not_found(ErrorCode.SCRIPT_NOT_FOUND, "script")
    return Response(status_code=204)


@router.post("/scripts/{script_id}/import", response_model=Script)
def import_lines(script_id: str, body: ScriptImport, svc: ServicesDep) -> Script:
    return svc.script.import_lines(script_id, body)


@router.post("/scripts/{script_id}/lines", response_model=Script)
def insert_line(script_id: str, body: LineInsert, svc: ServicesDep) -> Script:
    return svc.script.insert_line(script_id, body)


@router.patch("/scripts/{script_id}/lines/{line_id}", response_model=Script)
def update_line(script_id: str, line_id: str, body: LinePatch, svc: ServicesDep) -> Script:
    """Edit a line or adopt one of its takes; new text or another speaker discards the
    line's takes."""
    return svc.script.update_line(script_id, line_id, body)


@router.delete("/scripts/{script_id}/lines/{line_id}", response_model=Script)
def delete_line(script_id: str, line_id: str, svc: ServicesDep) -> Script:
    return svc.script.delete_line(script_id, line_id)


@router.post("/scripts/{script_id}/lines/{line_id}/move", response_model=Script)
def move_line(script_id: str, line_id: str, body: LineMove, svc: ServicesDep) -> Script:
    return svc.script.move_line(script_id, line_id, body)


@router.post("/scripts/{script_id}/render", response_model=JobAccepted | None)
def render_script(
    script_id: str, body: ScriptRenderRequest, svc: ServicesDep
) -> JobAccepted | None:
    """Render lines in order as one job; `null` when nothing needs rendering."""
    job = svc.script.enqueue_render(script_id, body)
    if job is None:
        return None
    return JobAccepted(job_id=job.id, queue_position=job.queue_position or 0)


@router.post("/scripts/{script_id}/assemble", response_model=AssembledScript)
def assemble_script(script_id: str, svc: ServicesDep) -> AssembledScript:
    return svc.script.assemble(script_id)


@router.post("/scripts/{script_id}/export", response_model=ScriptExported)
def export_script(script_id: str, body: ScriptExportRequest, svc: ServicesDep) -> ScriptExported:
    """Per-line files (naming template), the merged drama and its subtitles, into a folder."""
    return svc.script.export(script_id, body)


@router.post("/scripts/{script_id}/file-names", response_model=FileNames)
def preview_file_names(script_id: str, body: FileNamesRequest, svc: ServicesDep) -> FileNames:
    """The per-line file names a naming template gives, to preview it before saving."""
    return svc.script.preview_names(script_id, body.naming_template)


@router.post("/scripts/{script_id}/table", response_model=ExportedFile)
def export_table(script_id: str, body: ScriptTableRequest, svc: ServicesDep) -> ExportedFile:
    """The lines as CSV / TSV (UTF-8 with a BOM), readable by `POST /scripts` again."""
    return svc.script.export_table(script_id, body)
