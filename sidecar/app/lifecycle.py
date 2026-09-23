"""Process-level helpers shared by the sidecar and the provisioning scripts."""

from __future__ import annotations

import os
import sys
import threading
import time
from collections.abc import Mapping

# ERROR_INVALID_PARAMETER from OpenProcess: no process with that id.
_WIN_NO_SUCH_PROCESS = 87
_UNIX_POLL_S = 1.0


def force_utf8() -> None:
    """UTF-8 stdout/stderr regardless of the console code page (cp932 on Japanese Windows).

    Rust also sets PYTHONUTF8/PYTHONIOENCODING; this covers manual runs.
    """
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")  # type: ignore[union-attr]
        except (AttributeError, ValueError):
            pass


def exit_with_parent(environ: Mapping[str, str] = os.environ) -> None:
    """Exit as soon as the app that started us is gone (golden rule 4).

    Rust passes its pid as IRODORI_PARENT_PID. On Windows the kill-on-close job object
    already ends the process tree; this is the backstop, and on macOS the only guard
    against a forced quit. (Not a blocking read on stdin: on Windows a pending read on
    the stdin pipe deadlocks `import torch` in another thread.) No-op for manual runs.
    """
    raw = environ.get("IRODORI_PARENT_PID", "")
    if not raw.isdigit():
        return
    pid = int(raw)
    target = _wait_for_windows_process if sys.platform == "win32" else _poll_unix_parent
    threading.Thread(target=target, args=(pid,), name="parent-watchdog", daemon=True).start()


def _wait_for_windows_process(pid: int) -> None:
    import ctypes
    from ctypes import wintypes

    synchronize = 0x00100000
    infinite = 0xFFFFFFFF
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
    kernel32.WaitForSingleObject.restype = wintypes.DWORD
    kernel32.WaitForSingleObject.argtypes = (wintypes.HANDLE, wintypes.DWORD)

    handle = kernel32.OpenProcess(synchronize, False, pid)
    if not handle:
        if ctypes.get_last_error() == _WIN_NO_SUCH_PROCESS:
            os._exit(0)
        return  # cannot watch (access denied): the job object still covers us
    kernel32.WaitForSingleObject(handle, infinite)  # ctypes releases the GIL here
    os._exit(0)


def _poll_unix_parent(pid: int) -> None:
    while True:
        time.sleep(_UNIX_POLL_S)
        if os.getppid() == 1 or not _unix_alive(pid):
            os._exit(0)


def _unix_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True
