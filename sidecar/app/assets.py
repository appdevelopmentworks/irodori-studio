"""Where downloaded model assets live under HF_HOME (`<data-root>/models`, D16).

Model and codec repos are pinned to a commit and stored as plain files by our own
resumable downloader (app/provision/download.py):

    <models>/pinned/<owner>--<name>/<commit>/<path in repo>

so the adapter can pass local paths to upstream (checkpoint, codec) and never
depends on the Hugging Face cache layout. Assets that upstream loads by branch
(SilentCipher) stay in the regular Hugging Face cache (`<models>/hub`).
"""

from __future__ import annotations

from pathlib import Path, PurePosixPath

PINNED_DIR = "pinned"


def pinned_repo_dir(models_root: Path, repo_id: str, commit: str) -> Path:
    owner, name = repo_id.split("/", 1)
    return models_root / PINNED_DIR / f"{owner}--{name}" / commit


def pinned_file(models_root: Path, repo_id: str, commit: str, path_in_repo: str) -> Path:
    parts = PurePosixPath(path_in_repo).parts
    if not parts or any(part in ("", ".", "..") for part in parts):
        raise ValueError(f"unsafe path in repo: {path_in_repo!r}")
    return pinned_repo_dir(models_root, repo_id, commit).joinpath(*parts)
