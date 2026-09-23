"""Download planning, resumable fetching and byte-progress accounting (no network)."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
from huggingface_hub.hf_api import RepoFile, RepoFolder

from app.assets import pinned_file
from app.provision.download import (
    ByteProgress,
    DownloadError,
    FileSpec,
    RepoSpec,
    fetch_resumable,
    load_repo_specs,
    make_bar_class,
    part_path,
    plan_files,
)

SHA_A = "a" * 40
SHA_B = "b" * 40
CONTENT = bytes(range(256)) * 40  # 10 240 bytes
CONTENT_SHA256 = hashlib.sha256(CONTENT).hexdigest()


class FakeApi:
    def __init__(self, commits: dict[tuple[str, str], str], trees: dict[str, list[object]]):
        self.commits = commits
        self.trees = trees

    def model_info(self, repo_id: str, revision: str) -> SimpleNamespace:
        return SimpleNamespace(sha=self.commits[(repo_id, revision)])

    def list_repo_tree(self, repo_id: str, revision: str, recursive: bool) -> list[object]:
        assert recursive
        return self.trees[repo_id]


def _events(capsys: pytest.CaptureFixture[str]) -> list[dict[str, object]]:
    lines = capsys.readouterr().out.splitlines()
    return [
        json.loads(line.split(" ", 1)[1]) for line in lines if line.startswith("IRODORI_EVENT ")
    ]


def test_repo_specs_cover_models_codecs_and_assets_once() -> None:
    manifest = {
        "models": [
            {
                "hf_repo": "m/one",
                "hf_revision": SHA_A,
                "codec_repo": "c/x",
                "codec_revision": SHA_B,
            },
            {
                "hf_repo": "m/two",
                "hf_revision": SHA_A,
                "codec_repo": "c/x",
                "codec_revision": SHA_B,
            },
        ],
        "shared_assets": [{"hf_repo": "s/wm", "hf_revision": "main", "expected_commit": SHA_A}],
    }
    specs = load_repo_specs(manifest)
    assert [s.repo_id for s in specs] == ["m/one", "c/x", "m/two", "s/wm"]
    assert all(s.pinned for s in specs[:3])
    assert specs[-1] == RepoSpec("s/wm", "main", SHA_A, pinned=False)


def test_plan_resolves_commits_hashes_and_storage(capsys: pytest.CaptureFixture[str]) -> None:
    lfs = {"size": 100, "oid": "f" * 64, "pointerSize": 134}  # Hub JSON: oid = sha256
    api = FakeApi(
        commits={("m/one", SHA_A): SHA_A, ("s/wm", "main"): SHA_B},
        trees={
            "m/one": [
                RepoFile(path="model.safetensors", size=100, oid="1" * 40, lfs=lfs),
                RepoFolder(path="tokenizer", oid="2"),
                RepoFile(path="tokenizer/tokenizer.json", size=5, oid="3" * 40),
            ],
            "s/wm": [RepoFile(path="44_1_khz/enc_c.ckpt", size=7, oid="4" * 40)],
        },
    )
    files = plan_files(api, [RepoSpec("m/one", SHA_A), RepoSpec("s/wm", "main", SHA_A, False)])

    assert [f.path for f in files] == [
        "model.safetensors",
        "tokenizer/tokenizer.json",
        "44_1_khz/enc_c.ckpt",
    ]
    assert files[0].expected == ("sha256", "f" * 64)
    assert files[1].expected == ("git-sha1", "3" * 40)
    assert files[0].pinned and not files[2].pinned
    # Branch-tracked assets download by branch so the cache records refs/main.
    assert files[2].commit == SHA_B and files[2].download_revision == "main"
    notices = [e for e in _events(capsys) if e["event"] == "notice"]
    assert notices == [
        {
            "event": "notice",
            "code": "asset_revision_changed",
            "repo": "s/wm",
            "expected": SHA_A,
            "actual": SHA_B,
        }
    ]


def test_pinned_paths_stay_inside_the_store(tmp_path: Path) -> None:
    path = pinned_file(tmp_path, "Owner/Repo", SHA_A, "tokenizer/tokenizer.json")
    assert path == tmp_path / "pinned" / "Owner--Repo" / SHA_A / "tokenizer" / "tokenizer.json"
    with pytest.raises(ValueError):
        pinned_file(tmp_path, "Owner/Repo", SHA_A, "../escape")


# ----- resumable fetch ----------------------------------------------------------------


class _DroppedStream(httpx.SyncByteStream):
    """Sends some bytes, then fails like a reset connection."""

    def __init__(self, data: bytes) -> None:
        self.data = data

    def __iter__(self):  # noqa: ANN204
        yield self.data
        raise httpx.ReadError("connection reset")


def _server(
    *, honor_range: bool = True, fail_after: int | None = None, log: list | None = None
) -> httpx.Client:
    """A Range-capable server; `fail_after` drops the connection once after N bytes."""
    state = {"failed": False}

    def handler(request: httpx.Request) -> httpx.Response:
        if log is not None:
            log.append(request.headers.get("range"))
        start = 0
        range_header = request.headers.get("range")
        if honor_range and range_header:
            start = int(range_header.removeprefix("bytes=").split("-")[0])
        status = 206 if start else 200
        body = CONTENT[start:]
        if fail_after is not None and not state["failed"]:
            state["failed"] = True
            return httpx.Response(status, stream=_DroppedStream(body[:fail_after]))
        return httpx.Response(status, content=body)

    return httpx.Client(transport=httpx.MockTransport(handler))


def _fetch(client: httpx.Client, dest: Path, expected=("sha256", CONTENT_SHA256), **kwargs):
    seen: list[int] = []
    fetch_resumable(client, "https://hub/file", dest, len(CONTENT), expected, seen.append, **kwargs)
    return seen


def test_fetch_downloads_and_verifies(tmp_path: Path) -> None:
    dest = tmp_path / "repo" / "model.safetensors"
    seen = _fetch(_server(), dest)
    assert dest.read_bytes() == CONTENT
    assert not part_path(dest).exists()
    assert seen[0] == 0 and seen[-1] == len(CONTENT)


def test_fetch_resumes_from_a_partial_file(tmp_path: Path) -> None:
    dest = tmp_path / "model.safetensors"
    part_path(dest).write_bytes(CONTENT[:4000])
    ranges: list[str | None] = []
    seen = _fetch(_server(log=ranges), dest)
    assert ranges == ["bytes=4000-"]
    assert seen[0] == 4000  # progress continues where the last run stopped
    assert dest.read_bytes() == CONTENT


def test_fetch_restarts_when_the_server_ignores_range(tmp_path: Path) -> None:
    dest = tmp_path / "model.safetensors"
    part_path(dest).write_bytes(CONTENT[:4000])
    _fetch(_server(honor_range=False), dest)
    assert dest.read_bytes() == CONTENT


def test_fetch_retries_after_a_dropped_connection(tmp_path: Path) -> None:
    dest = tmp_path / "model.safetensors"
    ranges: list[str | None] = []
    _fetch(_server(fail_after=3000, log=ranges), dest, retry_delay=0)
    assert ranges == [None, "bytes=3000-"]
    assert dest.read_bytes() == CONTENT


def test_fetch_rejects_corrupt_content(tmp_path: Path) -> None:
    dest = tmp_path / "model.safetensors"
    with pytest.raises(DownloadError) as info:
        _fetch(_server(), dest, expected=("sha256", "0" * 64))
    assert info.value.code == "download_failed"
    assert not dest.exists() and not part_path(dest).exists()


def test_fetch_verifies_git_blob_hashes(tmp_path: Path) -> None:
    git_sha1 = hashlib.sha1(f"blob {len(CONTENT)}\0".encode() + CONTENT).hexdigest()
    dest = tmp_path / "tokenizer.json"
    _fetch(_server(), dest, expected=("git-sha1", git_sha1))
    assert dest.read_bytes() == CONTENT


# ----- progress -----------------------------------------------------------------------


def test_byte_progress_takes_the_best_bar_and_caps_at_file_size() -> None:
    progress = ByteProgress(total=150)
    progress.skip(20)
    progress.begin(FileSpec("r", "big.bin", 100, SHA_A, SHA_A, True))
    progress.bar_value(1, 30)  # network transfer
    progress.bar_value(2, 45)  # bytes written
    assert progress.snapshot() == (65, "big.bin")
    progress.bar_value(2, 180)  # never beyond the file size
    assert progress.snapshot() == (120, "big.bin")
    progress.finish()
    assert progress.snapshot() == (120, None)


def test_bar_class_counts_resumed_bytes_and_rollbacks() -> None:
    progress = ByteProgress(total=100)
    progress.begin(FileSpec("r", "f.bin", 100, SHA_A, SHA_A, False))
    bar_class = make_bar_class(progress)
    bar = bar_class(total=100, initial=40, unit="B")
    assert progress.snapshot()[0] == 40
    bar.update(25)
    assert progress.snapshot()[0] == 65
    # A server that ignores Range makes huggingface_hub roll the counter back.
    bar.update(-65)
    assert progress.snapshot()[0] == 0
    bar.close()
