"""`TorchBackend`: maps our requests onto upstream `InferenceRuntime` / `SamplingRequest`.

This is the ONLY module allowed to import `irodori_tts` (D3; enforced by
tests/test_dependency_policy.py). Never edit third_party/Irodori-TTS.
Implemented in Session 2.
"""
