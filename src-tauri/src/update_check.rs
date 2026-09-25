//! Startup check of the latest GitHub Release; notification only (D15). The request goes
//! through the system's curl (`platform::http_get`), so no TLS stack is bundled. Being
//! offline is not an error worth showing at startup; a manual check reports it.

use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, ErrorCode};
use crate::platform;

const API_URL: &str =
    "https://api.github.com/repos/appdevelopmentworks/irodori-studio/releases/latest";
/// The Releases page: the only address the app opens in the browser for updates.
pub const RELEASES_URL: &str = "https://github.com/appdevelopmentworks/irodori-studio/releases";
const TIMEOUT: Duration = Duration::from_secs(8);

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ReleaseInfo {
    /// Without a leading "v".
    pub version: String,
    /// This release's page (always under the Releases page).
    pub url: String,
    pub published_at: Option<String>,
    /// Newer than the running app.
    pub newer: bool,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct UpdateState {
    pub checking: bool,
    pub latest: Option<ReleaseInfo>,
    /// Why the last check failed (network_error, update_check_failed).
    pub error: Option<ErrorCode>,
    /// Unix seconds of the last finished check.
    pub checked_at: Option<u64>,
    /// The version the user chose not to be told about (from settings).
    pub skipped_version: Option<String>,
}

#[derive(Debug, Deserialize)]
struct Release {
    tag_name: String,
    html_url: Option<String>,
    published_at: Option<String>,
}

/// Ask GitHub for the latest release (drafts and pre-releases are never "latest").
/// `None`: nothing is published yet (GitHub answers 404), so nothing is newer.
pub fn fetch_latest(current: &str) -> Result<Option<ReleaseInfo>, AppError> {
    let agent = format!("irodori-studio/{current}");
    let headers = [
        ("Accept", "application/vnd.github+json"),
        ("User-Agent", agent.as_str()),
    ];
    let (status, body) = platform::http_get(API_URL, &headers, TIMEOUT)
        .map_err(|e| AppError::with_detail(ErrorCode::NetworkError, e.to_string()))?;
    if status == 404 {
        return Ok(None);
    }
    if status != 200 {
        return Err(AppError::with_detail(
            ErrorCode::UpdateCheckFailed,
            format!("HTTP {status}"),
        ));
    }
    parse_release(&body, current).map(Some)
}

pub fn parse_release(body: &str, current: &str) -> Result<ReleaseInfo, AppError> {
    let release: Release = serde_json::from_str(body)
        .map_err(|e| AppError::with_detail(ErrorCode::UpdateCheckFailed, e.to_string()))?;
    let version = release
        .tag_name
        .trim()
        .trim_start_matches(['v', 'V'])
        .to_string();
    if parse_version(&version).is_none() {
        return Err(AppError::with_detail(
            ErrorCode::UpdateCheckFailed,
            format!("tag {:?}", release.tag_name),
        ));
    }
    let url = release
        .html_url
        .filter(|url| is_release_url(url))
        .unwrap_or_else(|| RELEASES_URL.to_string());
    Ok(ReleaseInfo {
        newer: is_newer(&version, current),
        version,
        url,
        published_at: release.published_at,
    })
}

/// Only pages of this app's Releases are ever opened.
pub fn is_release_url(url: &str) -> bool {
    url == RELEASES_URL
        || url
            .strip_prefix(RELEASES_URL)
            .is_some_and(|rest| rest.starts_with('/') && !rest.contains(".."))
}

/// Semantic-version order: "1.2.10" > "1.2.9", and a pre-release sorts before its release.
pub fn is_newer(candidate: &str, current: &str) -> bool {
    match (parse_version(candidate), parse_version(current)) {
        (Some(a), Some(b)) => a > b,
        _ => false,
    }
}

/// (major, minor, patch, is a release rather than a pre-release)
fn parse_version(text: &str) -> Option<(u64, u64, u64, bool)> {
    let text = text.split('+').next()?;
    let (core, pre) = match text.split_once('-') {
        Some((core, pre)) => (core, Some(pre)),
        None => (text, None),
    };
    let mut parts = core.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next().map_or(Some(0), |p| p.parse().ok())?;
    let patch = parts.next().map_or(Some(0), |p| p.parse().ok())?;
    if parts.next().is_some() {
        return None;
    }
    Some((major, minor, patch, pre.is_none()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn orders_versions() {
        assert!(is_newer("0.2.0", "0.1.0"));
        assert!(is_newer("1.2.10", "1.2.9"));
        assert!(is_newer("1.0.0", "1.0.0-beta.1"));
        assert!(!is_newer("1.0.0-beta.1", "1.0.0"));
        assert!(!is_newer("0.1.0", "0.1.0"));
        assert!(!is_newer("0.0.9", "0.1.0"));
        assert!(is_newer("1.1", "1.0.9"));
        assert!(!is_newer("garbage", "0.1.0"));
    }

    #[test]
    fn parses_a_release() {
        let body = r#"{"tag_name":"v0.3.1","html_url":"https://github.com/appdevelopmentworks/irodori-studio/releases/tag/v0.3.1","published_at":"2026-10-01T00:00:00Z","draft":false}"#;
        let info = parse_release(body, "0.1.0").unwrap();
        assert_eq!(info.version, "0.3.1");
        assert!(info.newer);
        assert!(info.url.ends_with("/releases/tag/v0.3.1"));
        assert_eq!(info.published_at.as_deref(), Some("2026-10-01T00:00:00Z"));
    }

    #[test]
    fn foreign_links_fall_back_to_the_releases_page() {
        let body = r#"{"tag_name":"0.2.0","html_url":"https://example.com/releases/0.2.0"}"#;
        assert_eq!(parse_release(body, "0.1.0").unwrap().url, RELEASES_URL);
        assert!(!is_release_url(&format!("{RELEASES_URL}.evil.example")));
        assert!(!is_release_url(&format!("{RELEASES_URL}/../../settings")));
        assert!(is_release_url(&format!("{RELEASES_URL}/tag/v1.0.0")));
    }

    #[test]
    fn rejects_bad_bodies() {
        assert_eq!(
            parse_release("not json", "0.1.0").unwrap_err().code,
            ErrorCode::UpdateCheckFailed
        );
        assert_eq!(
            parse_release(r#"{"tag_name":"nightly"}"#, "0.1.0")
                .unwrap_err()
                .code,
            ErrorCode::UpdateCheckFailed
        );
    }
}
