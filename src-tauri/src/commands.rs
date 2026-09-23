//! Tauri commands exposed to the frontend (e.g. `get_sidecar_port`, D10). Commands
//! return `Result<T, String>` where the string is an error code the frontend
//! translates, never prose (D17). Implemented from Session 1.
