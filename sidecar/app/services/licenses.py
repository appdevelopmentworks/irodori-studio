"""The Python packages installed in the runtime venv and the licenses their metadata name,
for the Settings screen (the app's own and bundled components are listed by the UI)."""

from __future__ import annotations

import importlib.metadata as metadata
from email.message import Message

from app.schemas import PackageLicense

# A `License` field longer than this is the license text, not its name.
_MAX_NAME_CHARS = 80


def installed_packages() -> list[PackageLicense]:
    found: dict[str, PackageLicense] = {}
    for dist in metadata.distributions():
        meta = dist.metadata
        name = meta.get("Name")
        if not name:
            continue
        found.setdefault(
            name.lower(),
            PackageLicense(name=name, version=dist.version, license=license_of(meta)),
        )
    return sorted(found.values(), key=lambda package: package.name.lower())


def license_of(meta: Message) -> str | None:
    """`License-Expression` (SPDX), else a short `License`, else the trove classifiers,
    else the first line of a license text when it names the license."""
    expression = (meta.get("License-Expression") or "").strip()
    if expression:
        return expression
    text = (meta.get("License") or "").strip()
    if text and "\n" not in text and len(text) <= _MAX_NAME_CHARS and text.upper() != "UNKNOWN":
        return text
    classifiers = [
        entry.split("::")[-1].strip()
        for entry in meta.get_all("Classifier") or []
        if entry.startswith("License ::")
    ]
    names = [name for name in dict.fromkeys(classifiers) if name != "OSI Approved"]
    if names:
        return ", ".join(names)
    first = text.splitlines()[0].strip() if text else ""
    if first and len(first) <= _MAX_NAME_CHARS and "license" in first.lower():
        return first
    return None
