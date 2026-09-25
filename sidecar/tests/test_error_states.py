"""Error states (Session 9): a full disk and a failed GPU get their own codes, and a
lost device keeps the engine unusable until the sidecar restarts."""

from __future__ import annotations

import errno
from email.message import Message

from conftest import generate, read_events, wait_ready

from app.engine.base import BackendError
from app.engine.irodori_adapter import device_failed
from app.errors import ErrorCode, job_failure_code, save_error_code
from app.services.licenses import license_of


def test_a_full_disk_has_its_own_code() -> None:
    full = OSError(errno.ENOSPC, "No space left on device")
    assert save_error_code(full) is ErrorCode.DISK_FULL
    assert job_failure_code(full) is ErrorCode.DISK_FULL
    assert save_error_code(PermissionError(errno.EACCES, "denied")) is ErrorCode.SAVE_FAILED
    assert job_failure_code(ValueError("boom")) is ErrorCode.SYNTHESIS_FAILED


def test_device_failures_are_recognized() -> None:
    assert device_failed(RuntimeError("CUDA error: an illegal memory access was encountered"))
    assert device_failed(RuntimeError("cuDNN error: CUDNN_STATUS_EXECUTION_FAILED"))

    class AcceleratorError(RuntimeError):
        pass

    assert device_failed(AcceleratorError("device lost"))
    assert not device_failed(RuntimeError("Expected all tensors to be on the same device"))


def test_a_lost_device_stops_the_engine_until_a_restart(make_client) -> None:
    client, backend = make_client()
    wait_ready(client)
    backend.fail_synthesis = BackendError("device_lost", "CUDA error: unspecified launch failure")
    events = read_events(client, generate(client))
    assert events[-1][0] == "failed" and events[-1][1]["code"] == "device_lost"

    engine = client.get("/health").json()["engine"]
    assert (engine["state"], engine["error_code"]) == ("error", "device_lost")
    assert "device_lost" in client.get("/system").json()["issues"]

    # Later work fails at once with the same code, even if the fault would not recur.
    backend.fail_synthesis = None
    response = client.post("/tts/generate", json={"text": "もう一度。"})
    if response.status_code == 202:
        events = read_events(client, response.json()["job_id"])
        assert events[-1][1]["code"] == "device_lost"
    else:
        assert response.json()["code"] == "device_lost"


def test_a_full_disk_fails_the_job_with_disk_full(make_client) -> None:
    client, backend = make_client()
    wait_ready(client)
    backend.fail_synthesis = OSError(errno.ENOSPC, "No space left on device")
    events = read_events(client, generate(client))
    assert events[-1][1]["code"] == "disk_full"
    # The engine itself is fine.
    assert client.get("/health").json()["engine"]["state"] == "ready"


def test_license_names_come_from_the_metadata() -> None:
    def meta(**fields: object) -> Message:
        message = Message()
        for key, value in fields.items():
            for item in value if isinstance(value, list) else [value]:
                message[key.replace("_", "-")] = str(item)
        return message

    assert license_of(meta(License_Expression="Apache-2.0")) == "Apache-2.0"
    assert license_of(meta(License="MIT")) == "MIT"
    assert license_of(meta(Classifier=["License :: OSI Approved :: BSD License"])) == "BSD License"
    text = "BSD 3-Clause License\n\nCopyright (c) Meta"
    assert license_of(meta(License=text)) == "BSD 3-Clause License"
    assert license_of(meta(License="UNKNOWN")) is None
    assert license_of(meta()) is None
