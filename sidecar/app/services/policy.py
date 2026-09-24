"""`watermark_policy(request, settings) -> bool`: the only place that decides whether the
SilentCipher watermark is applied (D12). Default ON; the user may turn it off.

Owner decision pending (requirements.md §11 #4): whether the watermark stays forced ON
when a generation clones a voice (reference audio or a speaker embedding). Option B is
`FORCE_WATERMARK_FOR_CLONING = True`.
"""

from __future__ import annotations

from app.schemas import Preferences, SynthesisRequest

FORCE_WATERMARK_FOR_CLONING = False


def watermark_policy(request: SynthesisRequest, settings: Preferences) -> bool:
    if FORCE_WATERMARK_FOR_CLONING and request.reference.kind != "none":
        return True
    return settings.watermark_enabled
