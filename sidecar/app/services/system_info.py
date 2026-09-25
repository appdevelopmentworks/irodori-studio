"""Device and runtime introspection for GET /system.

torch is imported lazily: it takes seconds to import, and the dev venv used for
linting and unit tests has no torch at all (D2) — /system then reports
`torch_unavailable` instead of failing.
"""

from __future__ import annotations

import gc
import platform
import sys
import threading
from types import ModuleType

from app.config import SidecarConfig, upstream_commit
from app.errors import ErrorCode
from app.schemas import DeviceInfo, MemoryInfo, SystemInfo, TorchInfo

_MB = 1024 * 1024
_torch_lock = threading.Lock()


def build_system_info(config: SidecarConfig) -> SystemInfo:
    issues: list[str] = []
    device = DeviceInfo(kind=config.device, precision=config.precision, available=False)
    torch_info: TorchInfo | None = None

    torch = _import_torch()
    if torch is None:
        issues.append(ErrorCode.TORCH_UNAVAILABLE.value)
    else:
        mps_available = _mps_available(torch)
        torch_info = TorchInfo(
            version=str(torch.__version__),
            cuda_version=torch.version.cuda,
            cuda_available=bool(torch.cuda.is_available()),
            mps_available=mps_available,
        )
        if config.device == "cuda":
            if torch_info.cuda_available:
                _fill_cuda(torch, device)
            else:
                issues.append(ErrorCode.CUDA_UNAVAILABLE.value)
        elif config.device == "mps":
            device.available = mps_available
            if not mps_available:
                issues.append(ErrorCode.MPS_UNAVAILABLE.value)
        else:
            device.available = True

    if config.device != "cuda":
        device.name = platform.processor() or platform.machine() or None
        _fill_system_memory(device)

    memory = _memory(torch, config.device)
    return SystemInfo(
        app_version=config.app_version,
        python_version=platform.python_version(),
        platform=_platform_name(),
        device=device,
        torch=torch_info,
        upstream_commit=upstream_commit(),
        ffmpeg_available=config.ffmpeg is not None and config.ffmpeg.is_file(),
        memory=memory,
        issues=issues,
    )


def clear_accelerator_cache() -> None:
    """Hand torch's cached, unused accelerator memory back to the device."""
    gc.collect()
    torch = _import_torch()
    if torch is None:
        return
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
    mps = getattr(torch, "mps", None)
    if mps is not None and _mps_available(torch) and hasattr(mps, "empty_cache"):
        mps.empty_cache()


def _memory(torch: ModuleType | None, device: str) -> MemoryInfo:
    memory = MemoryInfo()
    try:
        import psutil
    except ImportError:
        psutil = None
    if psutil is not None:
        virtual = psutil.virtual_memory()
        memory.system_total_mb = int(virtual.total // _MB)
        memory.system_used_mb = int((virtual.total - virtual.available) // _MB)
        memory.process_mb = int(psutil.Process().memory_info().rss // _MB)
    if torch is None:
        return memory
    try:
        if device == "cuda" and torch.cuda.is_available():
            index = torch.cuda.current_device()
            memory.accelerator_allocated_mb = int(torch.cuda.memory_allocated(index) // _MB)
            memory.accelerator_reserved_mb = int(torch.cuda.memory_reserved(index) // _MB)
        elif device == "mps" and _mps_available(torch):
            memory.accelerator_allocated_mb = int(torch.mps.current_allocated_memory() // _MB)
            memory.accelerator_reserved_mb = int(torch.mps.driver_allocated_memory() // _MB)
    except (RuntimeError, AttributeError):
        pass
    return memory


def _import_torch() -> ModuleType | None:
    with _torch_lock:
        try:
            import torch
        except Exception:
            return None
        return torch


def _mps_available(torch: ModuleType) -> bool:
    backend = getattr(torch.backends, "mps", None)
    return bool(backend is not None and backend.is_available())


def _fill_cuda(torch: ModuleType, device: DeviceInfo) -> None:
    index = torch.cuda.current_device()
    major, minor = torch.cuda.get_device_capability(index)
    free, total = torch.cuda.mem_get_info(index)
    device.available = True
    device.name = torch.cuda.get_device_name(index)
    device.compute_capability = f"{major}.{minor}"
    device.memory_total_mb = int(total // _MB)
    device.memory_used_mb = int((total - free) // _MB)


def _fill_system_memory(device: DeviceInfo) -> None:
    """Unified memory on Apple Silicon, system RAM in CPU mode."""
    try:
        import psutil
    except ImportError:
        return
    memory = psutil.virtual_memory()
    device.memory_total_mb = int(memory.total // _MB)
    device.memory_used_mb = int((memory.total - memory.available) // _MB)


def _platform_name() -> str:
    if sys.platform == "win32":
        return "windows"
    if sys.platform == "darwin":
        return "macos"
    if sys.platform.startswith("linux"):
        return "linux"
    return "other"
