"""upstream.json and models.json stay consistent with the pinned submodule."""

from __future__ import annotations

import json
import re
import shutil
import subprocess
from pathlib import Path

import pytest
import tomli

SIDECAR_DIR = Path(__file__).resolve().parents[1]
UPSTREAM_DIR = SIDECAR_DIR.parent / "third_party" / "Irodori-TTS"
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
RANGE_RE = re.compile(r"^(?P<name>[A-Za-z0-9_-]+)>=(?P<lo>\d+\.\d+)\.0,<(?P<hi>\d+\.\d+)\.0$")


def _json(name: str) -> dict:
    return json.loads((SIDECAR_DIR / name).read_text(encoding="utf-8"))


def test_upstream_commit_matches_the_submodule_checkout() -> None:
    git = shutil.which("git")
    if git is None:
        pytest.skip("git is not available")
    head = subprocess.run(
        [git, "-C", str(UPSTREAM_DIR), "rev-parse", "HEAD"],
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    assert _json("upstream.json")["commit"] == head, "bump sidecar/upstream.json with the submodule"


def test_torch_spec_follows_upstream_cu128_extra() -> None:
    upstream = tomli.loads((UPSTREAM_DIR / "pyproject.toml").read_text(encoding="utf-8"))
    expected = {}
    for requirement in upstream["project"]["optional-dependencies"]["cu128"]:
        match = RANGE_RE.match(requirement.replace(" ", ""))
        if match and match["name"] in {"torch", "torchaudio", "torchcodec"}:
            major, minor = match["lo"].split(".")
            assert match["hi"] == f"{major}.{int(minor) + 1}", requirement
            expected[match["name"]] = f"{match['name']}=={match['lo']}.*"

    torch = _json("upstream.json")["torch"]
    assert sorted(torch["packages"] + torch["pypi_packages"]) == sorted(expected.values())
    # torchcodec has no Windows build on the PyTorch indexes; it must come from PyPI.
    assert all(p.startswith("torchcodec") for p in torch["pypi_packages"])

    indexes = {i["name"]: i["url"] for i in upstream["tool"]["uv"]["index"]}
    assert torch["index"] == {"cuda": indexes["pytorch-cu128"], "cpu": indexes["pytorch-cpu"]}


def test_models_json_pins_commits() -> None:
    registry = _json("models.json")
    ids = [m["id"] for m in registry["models"]]
    assert len(ids) == len(set(ids))
    assert registry["default_model"] in ids
    for model in registry["models"]:
        assert SHA_RE.match(model["hf_revision"]), model["id"]
        assert SHA_RE.match(model["codec_revision"]), model["id"]
    for asset in registry["shared_assets"]:
        # Branch-tracked assets record the commit they were verified at.
        assert SHA_RE.match(asset["hf_revision"]) or SHA_RE.match(asset["expected_commit"])
