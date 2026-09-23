//! First-run setup: uv python → venv → base deps → torch (platform index, D2) →
//! model downloads with resume → marker file. Idempotent; streams progress events.
//! Implemented in Session 1.
