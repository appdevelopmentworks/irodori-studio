"""GET /health and GET /system without a model (and without torch in the dev venv)."""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.config import SidecarConfig
from app.main import create_app


def _client(**env: str) -> TestClient:
    environ = {"IRODORI_DEVICE": "cpu", "IRODORI_APP_VERSION": "9.9.9", **env}
    return TestClient(create_app(SidecarConfig.from_env(port=0, environ=environ)))


def test_health() -> None:
    # Without the lifespan (no `with`), nothing starts: the engine stays idle.
    response = _client().get("/health")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    engine = body["engine"]
    assert (engine["state"], engine["model_id"], engine["error_code"]) == (
        "idle",
        "irodori-v4.1-small",
        None,
    )
    assert engine["runtime"]["device"] == "cpu"


def test_system_reports_configuration() -> None:
    body = _client(IRODORI_DEVICE="cpu", IRODORI_PRECISION="fp32").get("/system").json()
    assert body["app_version"] == "9.9.9"
    assert body["device"]["kind"] == "cpu"
    assert body["device"]["precision"] == "fp32"
    assert body["upstream_commit"] and len(body["upstream_commit"]) == 40
    assert body["active_model"] is None
    assert body["queue_length"] == 0
    if body["torch"] is None:
        assert "torch_unavailable" in body["issues"]


def test_invalid_device_falls_back_to_cpu() -> None:
    config = SidecarConfig.from_env(port=0, environ={"IRODORI_DEVICE": "tpu"})
    assert config.device == "cpu"


def test_cors_allows_only_configured_origins() -> None:
    client = _client(IRODORI_ALLOWED_ORIGINS="http://tauri.localhost, tauri://localhost")
    allowed = client.get("/health", headers={"Origin": "http://tauri.localhost"})
    assert allowed.headers.get("access-control-allow-origin") == "http://tauri.localhost"
    foreign = client.get("/health", headers={"Origin": "https://example.com"})
    assert "access-control-allow-origin" not in foreign.headers


def test_system_reports_memory_and_clears_the_cache() -> None:
    client = _client()
    memory = client.get("/system").json()["memory"]
    assert set(memory) == {
        "process_mb",
        "system_total_mb",
        "system_used_mb",
        "accelerator_allocated_mb",
        "accelerator_reserved_mb",
    }
    # psutil comes with the runtime's dependencies.
    assert memory["process_mb"] > 0 and memory["system_total_mb"] >= memory["system_used_mb"]
    assert client.post("/system/cache/clear").status_code == 204


def test_licenses_list_the_runtime_packages() -> None:
    packages = _client().get("/system/licenses").json()
    by_name = {package["name"].lower(): package for package in packages}
    assert by_name["fastapi"]["license"] == "MIT"
    assert all(package["version"] for package in packages)
    names = [package["name"].lower() for package in packages]
    assert names == sorted(names) and len(names) == len(set(names))
