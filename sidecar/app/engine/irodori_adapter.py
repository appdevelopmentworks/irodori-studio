"""`TorchBackend`: maps our requests onto upstream `InferenceRuntime` / `SamplingRequest`.

This is the ONLY module allowed to import `irodori_tts` (D3; enforced by
tests/test_dependency_policy.py). Never edit third_party/Irodori-TTS.
The backend itself is implemented in Session 2.
"""

from __future__ import annotations


def check_upstream() -> dict[str, object]:
    """Import the upstream runtime once, proving the provisioned venv is complete.

    Used by first-run setup (app/provision/selfcheck.py). Reports instead of raising:
    the caller turns a failure into an error code.
    """
    try:
        import irodori_tts.inference_runtime  # noqa: F401
    except Exception as exc:
        return {"importable": False, "error": f"{type(exc).__name__}: {exc}"}
    return {"importable": True, "error": None}
