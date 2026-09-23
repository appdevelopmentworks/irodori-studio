//! `settings.json` in the Tauri app config dir. Rust owns settings; the WebView uses no
//! browser storage (D11, D16). Unknown or invalid values fall back to defaults so an
//! old or hand-edited file never blocks startup.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

/// Bump when the first-run terms change; users must accept the new version (D13).
pub const TERMS_VERSION: u32 = 1;

pub const SUPPORTED_LOCALES: [&str; 4] = ["ja", "en", "zh-Hans", "de"];

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeviceChoice {
    /// Follow the platform probe (GPU when usable).
    #[default]
    Auto,
    /// Explicit CPU mode (D7).
    Cpu,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TermsAcceptance {
    pub version: u32,
    /// Unix seconds.
    pub accepted_at: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub locale: Option<String>,
    pub terms: Option<TermsAcceptance>,
    pub data_root: Option<PathBuf>,
    pub device: DeviceChoice,
}

impl Settings {
    pub fn terms_accepted(&self) -> bool {
        self.terms
            .as_ref()
            .is_some_and(|t| t.version >= TERMS_VERSION)
    }

    fn sanitized(mut self) -> Self {
        if !self
            .locale
            .as_deref()
            .is_some_and(|l| SUPPORTED_LOCALES.contains(&l))
        {
            self.locale = None;
        }
        self
    }
}

pub fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Load settings. A missing file gives defaults; an unreadable one is moved aside
/// (kept for inspection) and replaced by defaults.
pub fn load(path: &Path) -> Settings {
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(_) => return Settings::default(),
    };
    match serde_json::from_str::<Settings>(text.trim_start_matches('\u{feff}')) {
        Ok(settings) => settings.sanitized(),
        Err(_) => {
            let aside = path.with_file_name(format!("settings.corrupt-{}.json", now_unix()));
            let _ = fs::rename(path, aside);
            Settings::default()
        }
    }
}

/// Persist settings atomically (write a temp file, then rename over the old one).
pub fn save(path: &Path, settings: &Settings) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(settings).map_err(io::Error::other)?;
    fs::write(&tmp, text)?;
    fs::rename(&tmp, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("irodori-cfg-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn round_trips() {
        let dir = temp_dir("roundtrip");
        let path = dir.join("settings.json");
        let settings = Settings {
            locale: Some("de".into()),
            terms: Some(TermsAcceptance {
                version: TERMS_VERSION,
                accepted_at: 1,
            }),
            data_root: Some(dir.join("data")),
            device: DeviceChoice::Cpu,
        };
        save(&path, &settings).unwrap();
        assert_eq!(load(&path), settings);
        assert!(load(&path).terms_accepted());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_file_gives_defaults() {
        let settings = load(&temp_dir("missing").join("settings.json"));
        assert_eq!(settings, Settings::default());
        assert!(!settings.terms_accepted());
    }

    #[test]
    fn corrupt_file_is_moved_aside() {
        let dir = temp_dir("corrupt");
        let path = dir.join("settings.json");
        fs::write(&path, "{ not json").unwrap();
        assert_eq!(load(&path), Settings::default());
        assert!(!path.exists());
        let kept = fs::read_dir(&dir).unwrap().count();
        assert_eq!(kept, 1);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn unsupported_locale_and_old_terms_are_ignored() {
        let dir = temp_dir("sanitize");
        let path = dir.join("settings.json");
        fs::write(
            &path,
            "\u{feff}{\"locale\":\"fr\",\"terms\":{\"version\":0,\"accepted_at\":5},\"extra\":1}",
        )
        .unwrap();
        let settings = load(&path);
        assert_eq!(settings.locale, None);
        assert!(!settings.terms_accepted());
        let _ = fs::remove_dir_all(&dir);
    }
}
