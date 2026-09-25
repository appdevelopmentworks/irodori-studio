//! Error codes returned to the frontend. Rust never returns user-facing prose: the
//! frontend maps each code to a translated message (D17, src/lib/errors.ts).
//! `detail` carries technical context for logs and the "details" disclosure only.

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    Internal,
    SettingsIo,
    InvalidLocale,
    PlatformUnsupported,
    DataRootInvalid,
    DataRootNotWritable,
    DiskSpaceInsufficient,
    SetupAlreadyRunning,
    SidecarSourceMissing,
    UvMissing,
    PythonInstallFailed,
    VenvFailed,
    DepsInstallFailed,
    TorchInstallFailed,
    NetworkError,
    DownloadFailed,
    SelfcheckFailed,
    CudaUnavailable,
    MpsUnavailable,
    SidecarSpawnFailed,
    SidecarExited,
    SidecarHealthTimeout,
    SidecarNotReady,
    ModelLoadFailed,
    ModelLoadTimeout,
    DataRootNotEmpty,
    DataMoveFailed,
    UpdateCheckFailed,
    RuntimeUnsupported,
    OpenFailed,
    Busy,
}

impl ErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            ErrorCode::Internal => "internal",
            ErrorCode::SettingsIo => "settings_io",
            ErrorCode::InvalidLocale => "invalid_locale",
            ErrorCode::PlatformUnsupported => "platform_unsupported",
            ErrorCode::DataRootInvalid => "data_root_invalid",
            ErrorCode::DataRootNotWritable => "data_root_not_writable",
            ErrorCode::DiskSpaceInsufficient => "disk_space_insufficient",
            ErrorCode::SetupAlreadyRunning => "setup_already_running",
            ErrorCode::SidecarSourceMissing => "sidecar_source_missing",
            ErrorCode::UvMissing => "uv_missing",
            ErrorCode::PythonInstallFailed => "python_install_failed",
            ErrorCode::VenvFailed => "venv_failed",
            ErrorCode::DepsInstallFailed => "deps_install_failed",
            ErrorCode::TorchInstallFailed => "torch_install_failed",
            ErrorCode::NetworkError => "network_error",
            ErrorCode::DownloadFailed => "download_failed",
            ErrorCode::SelfcheckFailed => "selfcheck_failed",
            ErrorCode::CudaUnavailable => "cuda_unavailable",
            ErrorCode::MpsUnavailable => "mps_unavailable",
            ErrorCode::SidecarSpawnFailed => "sidecar_spawn_failed",
            ErrorCode::SidecarExited => "sidecar_exited",
            ErrorCode::SidecarHealthTimeout => "sidecar_health_timeout",
            ErrorCode::SidecarNotReady => "sidecar_not_ready",
            ErrorCode::ModelLoadFailed => "model_load_failed",
            ErrorCode::ModelLoadTimeout => "model_load_timeout",
            ErrorCode::DataRootNotEmpty => "data_root_not_empty",
            ErrorCode::DataMoveFailed => "data_move_failed",
            ErrorCode::UpdateCheckFailed => "update_check_failed",
            ErrorCode::RuntimeUnsupported => "runtime_unsupported",
            ErrorCode::OpenFailed => "open_failed",
            ErrorCode::Busy => "busy",
        }
    }
}

#[derive(Debug, Clone, Serialize, thiserror::Error)]
#[error("{}{}", code.as_str(), detail.as_deref().map(|d| format!(": {d}")).unwrap_or_default())]
pub struct AppError {
    pub code: ErrorCode,
    pub detail: Option<String>,
}

impl AppError {
    pub fn new(code: ErrorCode) -> Self {
        Self { code, detail: None }
    }

    pub fn with_detail(code: ErrorCode, detail: impl Into<String>) -> Self {
        Self {
            code,
            detail: Some(detail.into()),
        }
    }
}

/// Tauri commands return `Result<T, String>` whose error is the bare code
/// (docs/coding-conventions.md).
impl From<AppError> for String {
    fn from(err: AppError) -> Self {
        err.code.as_str().to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_codes_in_snake_case() {
        let err = AppError::with_detail(ErrorCode::DiskSpaceInsufficient, "need 15 GB");
        let json = serde_json::to_value(&err).unwrap();
        assert_eq!(json["code"], "disk_space_insufficient");
        assert_eq!(json["detail"], "need 15 GB");
        assert_eq!(String::from(err), "disk_space_insufficient");
    }

    #[test]
    fn as_str_matches_serde() {
        for code in [
            ErrorCode::UvMissing,
            ErrorCode::SidecarHealthTimeout,
            ErrorCode::DataRootNotEmpty,
            ErrorCode::Busy,
        ] {
            let json = serde_json::to_value(code).unwrap();
            assert_eq!(json, code.as_str());
        }
    }
}
