"""Dependency and import policy guards (D2, D3). Pure Python: no torch, no GPU."""

from __future__ import annotations

import ast
import re
from pathlib import Path

import tomli

SIDECAR_DIR = Path(__file__).resolve().parents[1]
APP_DIR = SIDECAR_DIR / "app"
ADAPTER = APP_DIR / "engine" / "irodori_adapter.py"
UPSTREAM_DIR = SIDECAR_DIR.parent / "third_party" / "Irodori-TTS"

# Installed per platform at first run (D2); never resolved or pinned by the sidecar.
TORCH_FAMILY = {"torch", "torchaudio", "torchcodec", "torchvision", "torchao", "torchdata"}
NEVER_MARKER = "sys_platform == 'torch-installed-at-first-run'"


def _normalize(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def _requirement_name(requirement: str) -> str:
    match = re.match(r"\s*([A-Za-z0-9][A-Za-z0-9._-]*)", requirement)
    assert match, f"unparseable requirement: {requirement!r}"
    return _normalize(match.group(1))


def _load_toml(name: str) -> dict:
    return tomli.loads((SIDECAR_DIR / name).read_text(encoding="utf-8"))


def _is_upstream_module(name: str) -> bool:
    return name == "irodori_tts" or name.startswith("irodori_tts.")


def test_no_direct_torch_dependency() -> None:
    project = _load_toml("pyproject.toml")
    names = {_requirement_name(r) for r in project["project"]["dependencies"]}
    for group in project.get("dependency-groups", {}).values():
        names |= {_requirement_name(r) for r in group if isinstance(r, str)}
    assert not names & TORCH_FAMILY


def test_torch_family_is_overridden_away() -> None:
    overrides = _load_toml("pyproject.toml")["tool"]["uv"]["override-dependencies"]
    markers = {}
    for requirement in overrides:
        name, _, marker = requirement.partition(";")
        markers[_requirement_name(name)] = marker.strip()
    for name in sorted(TORCH_FAMILY):
        assert markers.get(name) == NEVER_MARKER, f"{name} must be overridden with {NEVER_MARKER}"


def test_lockfile_has_no_torch_or_cuda_packages() -> None:
    names = {_normalize(p["name"]) for p in _load_toml("uv.lock")["package"]}
    assert not names & TORCH_FAMILY
    assert not sorted(n for n in names if n.startswith("nvidia-"))


def test_only_the_adapter_imports_upstream() -> None:
    offenders = []
    for path in sorted(APP_DIR.rglob("*.py")):
        if path == ADAPTER:
            continue
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                modules = [alias.name for alias in node.names]
            elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
                modules = [node.module]
            elif (
                isinstance(node, ast.Call)
                and getattr(node.func, "attr", getattr(node.func, "id", None))
                in ("import_module", "__import__")
                and node.args
                and isinstance(node.args[0], ast.Constant)
                and isinstance(node.args[0].value, str)
            ):
                modules = [node.args[0].value]
            else:
                continue
            if any(_is_upstream_module(m) for m in modules):
                offenders.append(f"{path.relative_to(SIDECAR_DIR).as_posix()}:{node.lineno}")
    assert not offenders, f"only app/engine/irodori_adapter.py may import irodori_tts: {offenders}"


def test_upstream_submodule_is_checked_out() -> None:
    runtime = UPSTREAM_DIR / "irodori_tts" / "inference_runtime.py"
    assert runtime.is_file(), "run `git submodule update --init --recursive`"
