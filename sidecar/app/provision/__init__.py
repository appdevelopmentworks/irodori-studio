"""Provisioning steps that run inside the runtime venv before the sidecar exists.

The Rust bootstrap (src-tauri/src/bootstrap.rs) runs them as `python -m
app.provision.<name>` and reads `IRODORI_EVENT {json}` lines from stdout.
"""
