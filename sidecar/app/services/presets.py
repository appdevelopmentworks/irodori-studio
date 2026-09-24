"""Parameter presets (requirements §6.8): named sets of sampling parameters checked
against the active model. A preset keeps the values that were given (those that differ
from the defaults); loading one sets exactly those and leaves the rest at their defaults."""

from __future__ import annotations

import json
from typing import Any

from app.engine import params as param_table
from app.engine.host import EngineHost
from app.errors import ApiError, ErrorCode
from app.schemas import Preset, PresetInput, PresetPatch, SamplingParams
from app.services.job_manager import now_iso
from app.storage.db import Database
from app.storage.files import is_id, new_id

MAX_PRESETS = 500


class PresetService:
    def __init__(self, *, db: Database, host: EngineHost) -> None:
        self._db = db
        self._host = host

    def list(self) -> list[Preset]:
        rows = self._db.query("SELECT * FROM presets ORDER BY name COLLATE NOCASE, created_at")
        return [_preset(row) for row in rows]

    def get(self, preset_id: str) -> Preset | None:
        if not is_id(preset_id):
            return None
        row = self._db.query_one("SELECT * FROM presets WHERE id = ?", (preset_id,))
        return None if row is None else _preset(row)

    def require(self, preset_id: str) -> Preset:
        preset = self.get(preset_id)
        if preset is None:
            raise ApiError(ErrorCode.PRESET_NOT_FOUND, "preset not found", status_code=404)
        return preset

    def create(self, body: PresetInput) -> Preset:
        count = self._db.query_one("SELECT COUNT(*) AS n FROM presets")
        if count and count["n"] >= MAX_PRESETS:
            raise ApiError(
                ErrorCode.INVALID_REQUEST,
                "too many presets",
                status_code=422,
                detail={"max_presets": MAX_PRESETS},
            )
        params = self._validated(body.params)
        preset_id = new_id()
        now = now_iso()
        with self._db.transaction() as conn:
            conn.execute(
                "INSERT INTO presets (id, name, params_json, created_at, updated_at)"
                " VALUES (?, ?, ?, ?, ?)",
                (preset_id, body.name.strip(), _dump(params), now, now),
            )
        return self.require(preset_id)

    def update(self, preset_id: str, body: PresetPatch) -> Preset:
        self.require(preset_id)
        columns: dict[str, Any] = {}
        if "name" in body.model_fields_set and body.name:
            columns["name"] = body.name.strip()
        if "params" in body.model_fields_set and body.params is not None:
            columns["params_json"] = _dump(self._validated(body.params))
        if columns:
            columns["updated_at"] = now_iso()
            assignments = ", ".join(f"{column} = ?" for column in columns)
            with self._db.transaction() as conn:
                conn.execute(
                    f"UPDATE presets SET {assignments} WHERE id = ?", [*columns.values(), preset_id]
                )
        return self.require(preset_id)

    def delete(self, preset_id: str) -> bool:
        if not is_id(preset_id):
            return False
        with self._db.transaction() as conn:
            return bool(conn.execute("DELETE FROM presets WHERE id = ?", (preset_id,)).rowcount)

    def _validated(self, params: SamplingParams) -> dict[str, Any]:
        provided = params.model_dump(mode="json", exclude_unset=True)
        try:
            param_table.resolve(
                provided,
                self._host.spec.capabilities,
                reference_kind="voice",
                has_caption=True,
            )
        except param_table.ParamError as exc:
            raise ApiError(
                ErrorCode.INVALID_PARAMS,
                str(exc),
                status_code=422,
                detail={"param": exc.name, "reason": exc.reason},
            ) from exc
        return provided


def _preset(row: Any) -> Preset:
    return Preset(
        id=row["id"],
        name=row["name"],
        params=SamplingParams(**json.loads(row["params_json"])),
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


def _dump(value: object) -> str:
    return json.dumps(value, ensure_ascii=False)
