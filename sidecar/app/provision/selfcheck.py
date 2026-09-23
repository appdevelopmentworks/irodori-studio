"""Verify the provisioned runtime before the first sidecar start.

    python -m app.provision.selfcheck --device cuda

Emits one `IRODORI_EVENT {"event": "selfcheck", ...}` line and exits 0 when the
runtime can serve the requested device, 1 otherwise; `issues` lists the reasons as
codes. `diagnostics` are informational and never fail the check.
"""

from __future__ import annotations

import argparse
import platform
import sys
import tempfile
from pathlib import Path
from types import ModuleType
from typing import Any

from app.engine import irodori_adapter
from app.lifecycle import force_utf8
from app.provision.events import describe, emit


def _check_cuda(torch: ModuleType, report: dict[str, Any], issues: list[str]) -> None:
    info: dict[str, Any] = {"available": bool(torch.cuda.is_available())}
    report["cuda"] = info
    if not info["available"]:
        issues.append("cuda_unavailable")
        return
    major, minor = torch.cuda.get_device_capability(0)
    info.update(
        name=torch.cuda.get_device_name(0),
        capability=f"{major}.{minor}",
        arch_list=list(torch.cuda.get_arch_list()),
    )
    try:
        # A real kernel launch: "no kernel image is available" surfaces here, not above.
        value = (torch.ones(8, device="cuda") * 2).sum().item()
        info["kernel_ok"] = value == 16.0
    except Exception as exc:
        info["kernel_error"] = describe(exc)
        issues.append("cuda_kernel_failed")


def _check_mps(torch: ModuleType, report: dict[str, Any], issues: list[str]) -> None:
    backend = getattr(torch.backends, "mps", None)
    info: dict[str, Any] = {"available": bool(backend is not None and backend.is_available())}
    report["mps"] = info
    if not info["available"]:
        issues.append("mps_unavailable")
        return
    try:
        info["kernel_ok"] = (torch.ones(8, device="mps") * 2).sum().item() == 16.0
    except Exception as exc:
        info["kernel_error"] = describe(exc)
        issues.append("mps_kernel_failed")


def _audio_io_diagnostics() -> dict[str, str]:
    """How `torchaudio.load` behaves here. Upstream falls back to soundfile only on
    RuntimeError, so any other exception type matters for reference audio (Session 2)."""
    try:
        import numpy as np
        import soundfile as sf
        import torchaudio
    except Exception as exc:
        return {"torchaudio_load": describe(exc)}
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "probe.wav"
        sf.write(str(path), np.zeros(4800, dtype="float32"), 48000)
        try:
            torchaudio.load(str(path))
        except Exception as exc:
            return {"torchaudio_load": describe(exc)}
    return {"torchaudio_load": "ok"}


def main(argv: list[str] | None = None) -> int:
    force_utf8()
    parser = argparse.ArgumentParser(prog="python -m app.provision.selfcheck")
    parser.add_argument("--device", choices=["cuda", "mps", "cpu"], required=True)
    args = parser.parse_args(argv)

    issues: list[str] = []
    report: dict[str, Any] = {"python": platform.python_version(), "device": args.device}
    try:
        import torch
    except Exception as exc:
        emit("selfcheck", **report, issues=["torch_unavailable"], torch_error=describe(exc))
        return 1

    report["torch"] = {"version": str(torch.__version__), "cuda_version": torch.version.cuda}
    if args.device == "cuda":
        _check_cuda(torch, report, issues)
    elif args.device == "mps":
        _check_mps(torch, report, issues)

    upstream = irodori_adapter.check_upstream()
    report["upstream"] = upstream
    if not upstream["importable"]:
        issues.append("upstream_import_failed")

    report["diagnostics"] = _audio_io_diagnostics()
    emit("selfcheck", **report, issues=issues)
    return 0 if not issues else 1


if __name__ == "__main__":
    sys.exit(main())
