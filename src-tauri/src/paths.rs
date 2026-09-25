//! Storage locations (D16). Settings live in the Tauri app config dir; everything
//! else — runtime venv, uv's cache and managed Python, models, user data, logs — lives
//! under the data root the user picks, so removing that one folder cleans up fully.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

use tauri::{AppHandle, Manager};

use crate::error::{AppError, ErrorCode};

pub fn settings_file(app: &AppHandle) -> Result<PathBuf, AppError> {
    app.path()
        .app_config_dir()
        .map(|dir| dir.join("settings.json"))
        .map_err(|e| AppError::with_detail(ErrorCode::SettingsIo, e.to_string()))
}

/// Default data root: local (non-roaming) app data, since it holds many gigabytes.
pub fn default_data_root(app: &AppHandle) -> Result<PathBuf, AppError> {
    app.path()
        .app_local_data_dir()
        .map(|dir| dir.join("data"))
        .map_err(|e| AppError::with_detail(ErrorCode::DataRootInvalid, e.to_string()))
}

#[derive(Debug, Clone)]
pub struct DataPaths {
    pub root: PathBuf,
    /// Hugging Face cache (`HF_HOME`).
    pub models: PathBuf,
    pub runtime: PathBuf,
    pub venv: PathBuf,
    /// uv-managed Python installations (`UV_PYTHON_INSTALL_DIR`).
    pub python: PathBuf,
    pub uv_cache: PathBuf,
    /// Bytecode cache (`PYTHONPYCACHEPREFIX`); the installed sidecar source is read-only.
    pub pycache: PathBuf,
    pub logs: PathBuf,
    pub voices: PathBuf,
    pub history: PathBuf,
    pub projects: PathBuf,
    pub exports: PathBuf,
}

impl DataPaths {
    pub fn new(root: &Path) -> Self {
        let runtime = root.join("runtime");
        Self {
            root: root.to_path_buf(),
            models: root.join("models"),
            venv: runtime.join("venv"),
            python: runtime.join("python"),
            uv_cache: runtime.join("uv-cache"),
            pycache: runtime.join("pycache"),
            runtime,
            logs: root.join("logs"),
            voices: root.join("voices"),
            history: root.join("history"),
            projects: root.join("projects"),
            exports: root.join("exports"),
        }
    }

    pub fn ensure(&self) -> io::Result<()> {
        for dir in [
            &self.root,
            &self.models,
            &self.runtime,
            &self.logs,
            &self.voices,
            &self.history,
            &self.projects,
            &self.exports,
        ] {
            fs::create_dir_all(dir)?;
        }
        Ok(())
    }

    pub fn venv_python(&self) -> PathBuf {
        if cfg!(windows) {
            self.venv.join("Scripts").join("python.exe")
        } else {
            self.venv.join("bin").join("python")
        }
    }

    /// First-run setup completion marker (bootstrap.rs).
    pub fn marker(&self) -> PathBuf {
        self.runtime.join("setup.json")
    }
}

/// Whether directories can be created at `path` (or its nearest existing ancestor).
pub fn can_create_in(path: &Path) -> bool {
    // Unique per call: concurrent inspections of one folder must not collide.
    static PROBES: AtomicUsize = AtomicUsize::new(0);
    let Some(base) = path.ancestors().find(|p| p.is_dir()) else {
        return false;
    };
    let probe = base.join(format!(
        ".irodori-write-test-{}-{}",
        std::process::id(),
        PROBES.fetch_add(1, Ordering::Relaxed)
    ));
    match fs::create_dir(&probe) {
        Ok(()) => {
            let _ = fs::remove_dir(&probe);
            true
        }
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn everything_lives_under_the_root() {
        let root = std::env::temp_dir().join("irodori-paths");
        let paths = DataPaths::new(&root);
        for p in [
            &paths.models,
            &paths.venv,
            &paths.python,
            &paths.uv_cache,
            &paths.pycache,
            &paths.logs,
            &paths.voices,
            &paths.exports,
        ] {
            assert!(
                p.starts_with(&root),
                "{} is outside the data root",
                p.display()
            );
        }
        assert!(paths.venv_python().starts_with(&paths.venv));
        assert!(paths.marker().starts_with(&paths.runtime));
    }
}
