//! Dev vs installed layout (D1). Dev runs use the live repo `sidecar/` and the pinned
//! submodule; installed builds use the bundled resources, where the stage script puts
//! `irodori_tts/` next to `app/` (Session 10).
//!
//! Sidecar directory resolution:
//!   1. `IRODORI_SIDECAR_DIR` (must contain pyproject.toml)
//!   2. dev: `<CARGO_MANIFEST_DIR>/../sidecar` (exists only on the build machine)
//!   3. installed: the bundled `sidecar` resource
//!
//! `IRODORI_FORCE_BUNDLED` skips 1–2 to test the installed layout on a dev machine.

use std::path::{Path, PathBuf};

use tauri::path::BaseDirectory;
use tauri::{AppHandle, Manager};

use crate::error::{AppError, ErrorCode};

#[derive(Debug, Clone)]
pub struct Layout {
    /// Contains app/, pyproject.toml, uv.lock, .python-version, models.json, upstream.json.
    pub sidecar_dir: PathBuf,
    /// Directory containing the `irodori_tts` package (goes on PYTHONPATH, D3).
    pub upstream_dir: PathBuf,
    /// Bundled uv, else `uv` found on PATH (dev).
    pub uv: PathBuf,
    /// Bundled LGPL ffmpeg, when staged (D20); in dev, else `ffmpeg` found on PATH.
    pub ffmpeg: Option<PathBuf>,
    pub installed: bool,
}

pub fn resolve(app: &AppHandle) -> Result<Layout, AppError> {
    let (sidecar_dir, installed) = resolve_sidecar(app)?;
    let upstream_dir = if installed {
        sidecar_dir.clone()
    } else {
        repo_root_of(&sidecar_dir)
            .join("third_party")
            .join("Irodori-TTS")
    };
    if !upstream_dir.join("irodori_tts").is_dir() {
        return Err(AppError::with_detail(
            ErrorCode::SidecarSourceMissing,
            format!("irodori_tts not found under {}", upstream_dir.display()),
        ));
    }

    let uv = resource(app, &format!("uv/{}", exe_name("uv")))
        .filter(|p| p.is_file())
        .or_else(|| find_on_path("uv"))
        .ok_or_else(|| AppError::new(ErrorCode::UvMissing))?;
    // Installed builds use only the bundled LGPL build (D20); dev runs may fall back to an
    // ffmpeg on PATH until Session 10 stages one.
    let ffmpeg = resource(app, &format!("ffmpeg/{}", exe_name("ffmpeg")))
        .filter(|p| p.is_file())
        .or_else(|| {
            if installed {
                None
            } else {
                find_on_path("ffmpeg")
            }
        });

    Ok(Layout {
        sidecar_dir,
        upstream_dir,
        uv,
        ffmpeg,
        installed,
    })
}

fn resolve_sidecar(app: &AppHandle) -> Result<(PathBuf, bool), AppError> {
    let has_project = |dir: &Path| dir.join("pyproject.toml").is_file();
    if std::env::var_os("IRODORI_FORCE_BUNDLED").is_none() {
        if let Some(dir) = std::env::var_os("IRODORI_SIDECAR_DIR").map(PathBuf::from) {
            if has_project(&dir) {
                return Ok((dir, false));
            }
        }
        let dev = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("sidecar");
        if has_project(&dev) {
            return Ok((dev.canonicalize().map(strip_verbatim).unwrap_or(dev), false));
        }
    }
    match resource(app, "sidecar") {
        Some(dir) if has_project(&dir) => Ok((dir, true)),
        _ => Err(AppError::new(ErrorCode::SidecarSourceMissing)),
    }
}

fn repo_root_of(sidecar_dir: &Path) -> PathBuf {
    sidecar_dir
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| sidecar_dir.to_path_buf())
}

fn resource(app: &AppHandle, rel: &str) -> Option<PathBuf> {
    app.path().resolve(rel, BaseDirectory::Resource).ok()
}

fn exe_name(stem: &str) -> String {
    if cfg!(windows) {
        format!("{stem}.exe")
    } else {
        stem.to_string()
    }
}

/// Search PATH like a shell would (dev convenience; installed builds bundle uv and ffmpeg).
fn find_on_path(stem: &str) -> Option<PathBuf> {
    let name = exe_name(stem);
    std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths)
            .map(|dir| dir.join(&name))
            .find(|candidate| candidate.is_file())
    })
}

/// `canonicalize` on Windows returns `\\?\C:\...`, which some tools reject.
fn strip_verbatim(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    match text.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC\\") => PathBuf::from(rest),
        _ => path,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_windows_verbatim_prefix_only_for_drive_paths() {
        assert_eq!(
            strip_verbatim(PathBuf::from(r"\\?\C:\Dev\x")),
            PathBuf::from(r"C:\Dev\x")
        );
        assert_eq!(
            strip_verbatim(PathBuf::from(r"\\?\UNC\server\share")),
            PathBuf::from(r"\\?\UNC\server\share")
        );
        assert_eq!(
            strip_verbatim(PathBuf::from("/tmp/x")),
            PathBuf::from("/tmp/x")
        );
    }

    #[test]
    fn dev_layout_points_at_repo_sidecar_and_submodule() {
        let dev = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("sidecar");
        assert!(dev.join("pyproject.toml").is_file());
        let upstream = repo_root_of(&dev.canonicalize().map(strip_verbatim).unwrap())
            .join("third_party")
            .join("Irodori-TTS");
        assert!(upstream.join("irodori_tts").is_dir());
    }
}
