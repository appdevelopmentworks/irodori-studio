"""Download every asset listed in models.json into HF_HOME, resumably.

Run by the Rust bootstrap inside the runtime venv, before the sidecar exists:

    python -m app.provision.download

Model and codec repos are fetched at their pinned commits into plain files
(app/assets.py) by a resumable HTTP download: bytes land in `<file>.part`, a restart
continues with a Range request, and each finished file is verified against the Hub's
hash before it is renamed into place. (huggingface_hub 1.x no longer resumes: every
attempt writes a fresh temporary file.) Shared assets that upstream loads by branch —
SilentCipher, via `snapshot_download("sony/silentcipher")` — go through the Hugging
Face cache instead, so `refs/<branch>` exists for the offline sidecar.

Progress goes to stdout as `IRODORI_EVENT` lines (events.py).
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import shutil
import sys
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx

from app.assets import pinned_file
from app.config import MODELS_JSON
from app.lifecycle import exit_with_parent, force_utf8
from app.provision.events import describe, emit

# Keep this much disk free after downloading, so the disk never fills to the last byte.
DISK_MARGIN_BYTES = 512 * 1024 * 1024
REPORT_INTERVAL_S = 0.25
CHUNK_BYTES = 1024 * 1024
ATTEMPTS = 5
RETRY_DELAY_S = 2.0
TIMEOUT = httpx.Timeout(60.0, connect=30.0)


class DownloadError(Exception):
    def __init__(self, code: str, detail: str) -> None:
        super().__init__(detail)
        self.code = code


@dataclass(frozen=True)
class RepoSpec:
    repo_id: str
    revision: str
    expected_commit: str | None = None
    # Pinned repos are stored as plain files; the rest use the Hugging Face cache.
    pinned: bool = True


@dataclass(frozen=True)
class FileSpec:
    repo_id: str
    path: str
    size: int
    commit: str
    download_revision: str
    pinned: bool
    # ("sha256", hex) for LFS/Xet files, ("git-sha1", hex) for regular git blobs.
    expected: tuple[str, str] | None = None


def load_repo_specs(manifest: dict[str, Any]) -> list[RepoSpec]:
    specs: list[RepoSpec] = []
    for model in manifest.get("models", []):
        specs.append(RepoSpec(model["hf_repo"], model["hf_revision"]))
        specs.append(RepoSpec(model["codec_repo"], model["codec_revision"]))
    for asset in manifest.get("shared_assets", []):
        specs.append(
            RepoSpec(asset["hf_repo"], asset["hf_revision"], asset.get("expected_commit"), False)
        )
    # Keep the order and drop duplicates (models may share a codec).
    return list(dict.fromkeys(specs))


def plan_files(api: Any, specs: list[RepoSpec]) -> list[FileSpec]:
    from huggingface_hub.hf_api import RepoFile

    files: list[FileSpec] = []
    for spec in specs:
        commit = api.model_info(spec.repo_id, revision=spec.revision).sha
        if spec.expected_commit and commit != spec.expected_commit:
            emit(
                "notice",
                code="asset_revision_changed",
                repo=spec.repo_id,
                expected=spec.expected_commit,
                actual=commit,
            )
        for entry in api.list_repo_tree(spec.repo_id, revision=commit, recursive=True):
            if not isinstance(entry, RepoFile):
                continue
            lfs = getattr(entry, "lfs", None)
            if lfs is not None and getattr(lfs, "sha256", None):
                expected: tuple[str, str] | None = ("sha256", lfs.sha256)
            elif getattr(entry, "blob_id", None):
                expected = ("git-sha1", entry.blob_id)
            else:
                expected = None
            files.append(
                FileSpec(
                    spec.repo_id,
                    entry.path,
                    int(entry.size or 0),
                    commit,
                    spec.revision,
                    spec.pinned,
                    expected,
                )
            )
    return files


# ----- resumable download of pinned files ---------------------------------------------


def part_path(dest: Path) -> Path:
    return dest.with_name(dest.name + ".part")


def file_digest(path: Path, kind: str, size: int) -> str:
    digest = hashlib.sha256() if kind == "sha256" else hashlib.sha1()
    if kind == "git-sha1":
        digest.update(f"blob {size}\0".encode())
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(CHUNK_BYTES), b""):
            digest.update(block)
    return digest.hexdigest()


def fetch_resumable(
    client: httpx.Client,
    url: str,
    dest: Path,
    size: int,
    expected: tuple[str, str] | None,
    on_bytes: Callable[[int], None],
    *,
    headers: dict[str, str] | None = None,
    attempts: int = ATTEMPTS,
    retry_delay: float = RETRY_DELAY_S,
) -> None:
    """Download `url` to `dest` via `<dest>.part`, continuing an existing partial file."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = part_path(dest)
    for attempt in range(1, attempts + 1):
        have = part.stat().st_size if part.exists() else 0
        if have > size:
            part.unlink()
            have = 0
        on_bytes(have)
        if have < size:
            # Byte offsets must refer to the raw file, so no transfer compression.
            request_headers = {**(headers or {}), "Accept-Encoding": "identity"}
            if have:
                request_headers["Range"] = f"bytes={have}-"
            try:
                with client.stream("GET", url, headers=request_headers) as response:
                    if response.status_code == 200:
                        mode, have = "wb", 0  # the server ignored Range: start over
                    elif response.status_code == 206:
                        mode = "ab"
                    else:
                        response.raise_for_status()
                        raise DownloadError("download_failed", f"HTTP {response.status_code}")
                    with part.open(mode) as out:
                        for chunk in response.iter_bytes():
                            out.write(chunk)
                            have += len(chunk)
                            on_bytes(have)
            except httpx.TransportError as exc:
                if attempt == attempts:
                    raise DownloadError("network_error", describe(exc)) from exc
                time.sleep(retry_delay * attempt)
                continue
        if part.stat().st_size != size:
            if attempt == attempts:
                raise DownloadError("download_failed", f"{dest.name}: size mismatch")
            continue
        if expected is not None and file_digest(part, expected[0], size) != expected[1]:
            part.unlink()
            raise DownloadError("download_failed", f"{dest.name}: {expected[0]} mismatch")
        part.replace(dest)
        return


# ----- progress -----------------------------------------------------------------------


class ByteProgress:
    """Byte progress across sequential file downloads.

    Fed by our own fetch (bar id 0) and by huggingface_hub's progress bars for cached
    assets: one bar per file over HTTP, two (transfer, bytes written) over Xet. The
    largest count seen for the file in flight, capped at its size, is the estimate.
    """

    def __init__(self, total: int) -> None:
        self.total = total
        self._finished = 0
        self._current_size = 0
        self._current_file: str | None = None
        self._bars: dict[int, int] = {}
        self._lock = threading.Lock()

    def skip(self, size: int) -> None:
        with self._lock:
            self._finished += size

    def begin(self, file: FileSpec) -> None:
        with self._lock:
            self._current_size = file.size
            self._current_file = file.path
            self._bars.clear()

    def finish(self) -> None:
        with self._lock:
            self._finished += self._current_size
            self._current_size = 0
            self._current_file = None
            self._bars.clear()

    def bar_value(self, bar_id: int, value: int) -> None:
        with self._lock:
            self._bars[bar_id] = value

    def snapshot(self) -> tuple[int, str | None]:
        with self._lock:
            current = min(self._current_size, max(self._bars.values(), default=0))
            return self._finished + max(current, 0), self._current_file


def make_bar_class(progress: ByteProgress) -> type:
    """A tqdm class for huggingface_hub's public `tqdm_class` hook that draws nothing.

    Counting happens in `update`, so it works even when huggingface_hub disables its
    progress bars (which stops tqdm's own counter).
    """
    from huggingface_hub.utils import tqdm as hf_tqdm

    class _Bar(hf_tqdm):
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            self._irodori_count = int(kwargs.get("initial") or 0)
            kwargs["file"] = io.StringIO()
            super().__init__(*args, **kwargs)
            progress.bar_value(id(self), self._irodori_count)

        def update(self, n: float | None = 1) -> bool | None:
            self._irodori_count += int(n or 0)
            progress.bar_value(id(self), self._irodori_count)
            return super().update(n)

    return _Bar


def _report_until(stop: threading.Event, progress: ByteProgress) -> None:
    last: tuple[int, str | None] | None = None
    while True:
        stopped = stop.wait(REPORT_INTERVAL_S)
        snapshot = progress.snapshot()
        if snapshot != last:
            done, file = snapshot
            emit("progress", done=done, total=progress.total, file=file)
            last = snapshot
        if stopped:
            return


def _error_code(exc: BaseException) -> str:
    if isinstance(exc, DownloadError):
        return exc.code
    if isinstance(exc, (httpx.TransportError, httpx.TimeoutException)):
        return "network_error"
    if isinstance(exc, OSError) and exc.errno == 28:  # ENOSPC
        return "disk_space_insufficient"
    return "download_failed"


def _remove_stale_cache_partials(cache_dir: Path) -> None:
    """A hard kill leaves huggingface_hub's uniquely named temp files behind; they are
    never reused. Safe to delete: nothing else writes to this cache during setup."""
    for partial in cache_dir.glob("*/blobs/*.incomplete"):
        try:
            partial.unlink()
        except OSError:
            pass


def main(argv: list[str] | None = None) -> int:
    force_utf8()
    parser = argparse.ArgumentParser(prog="python -m app.provision.download")
    parser.add_argument("--manifest", type=Path, default=MODELS_JSON)
    args = parser.parse_args(argv)
    exit_with_parent()

    from huggingface_hub import (
        HfApi,
        constants,
        hf_hub_download,
        hf_hub_url,
        try_to_load_from_cache,
    )
    from huggingface_hub.utils import build_hf_headers

    models_root = Path(constants.HF_HOME)
    cache_dir = Path(constants.HF_HUB_CACHE)
    cache_dir.mkdir(parents=True, exist_ok=True)
    _remove_stale_cache_partials(cache_dir)

    try:
        manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
        files = plan_files(HfApi(), load_repo_specs(manifest))
    except Exception as exc:
        emit("error", code=_error_code(exc), detail=describe(exc))
        return 2

    progress = ByteProgress(sum(f.size for f in files))
    pending: list[FileSpec] = []
    remaining = 0
    for file in files:
        if file.pinned:
            dest = pinned_file(models_root, file.repo_id, file.commit, file.path)
            if dest.is_file() and dest.stat().st_size == file.size:
                progress.skip(file.size)
                continue
            part = part_path(dest)
            remaining += file.size - (part.stat().st_size if part.exists() else 0)
        else:
            cached = try_to_load_from_cache(file.repo_id, file.path, revision=file.commit)
            if isinstance(cached, str):
                progress.skip(file.size)
                continue
            remaining += file.size
        pending.append(file)

    free = shutil.disk_usage(models_root).free
    if remaining + DISK_MARGIN_BYTES > free:
        needed = remaining + DISK_MARGIN_BYTES
        emit("error", code="disk_space_insufficient", needed=needed, free=free)
        return 3

    emit("plan", total=progress.total, remaining=remaining, files=len(files), pending=len(pending))
    bar_class = make_bar_class(progress)
    stop = threading.Event()
    reporter = threading.Thread(target=_report_until, args=(stop, progress), daemon=True)
    reporter.start()
    try:
        with httpx.Client(follow_redirects=True, timeout=TIMEOUT) as client:
            for file in pending:
                progress.begin(file)
                if file.pinned:
                    fetch_resumable(
                        client,
                        hf_hub_url(file.repo_id, file.path, revision=file.commit),
                        pinned_file(models_root, file.repo_id, file.commit, file.path),
                        file.size,
                        file.expected,
                        lambda done: progress.bar_value(0, done),
                        headers=build_hf_headers(),
                    )
                else:
                    hf_hub_download(
                        file.repo_id,
                        file.path,
                        revision=file.download_revision,
                        tqdm_class=bar_class,
                    )
                progress.finish()
    except Exception as exc:
        emit("error", code=_error_code(exc), detail=describe(exc))
        return 2
    finally:
        stop.set()
        reporter.join()

    emit("done", total=progress.total)
    return 0


if __name__ == "__main__":
    sys.exit(main())
