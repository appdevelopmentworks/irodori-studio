//! The log files under `<data-root>/logs`, read for the Settings log viewer and the error
//! screen. Rust tees the sidecar's output into `sidecar.log`; setup writes `setup.log`.

use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::Path;

use serde::{Deserialize, Serialize};

/// Enough for the last few hundred lines.
pub const TAIL_BYTES: u64 = 256 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LogName {
    Sidecar,
    Setup,
}

impl LogName {
    fn file_name(self) -> &'static str {
        match self {
            LogName::Sidecar => "sidecar.log",
            LogName::Setup => "setup.log",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct LogTail {
    pub name: LogName,
    pub path: String,
    /// The whole file's size; 0 when it does not exist yet.
    pub size: u64,
    /// The end of the file, starting at a line boundary.
    pub text: String,
    pub truncated: bool,
}

pub fn read_tail(dir: &Path, name: LogName, max_bytes: u64) -> LogTail {
    let path = dir.join(name.file_name());
    let (size, text, truncated) = read(&path, max_bytes).unwrap_or_default();
    LogTail {
        name,
        path: path.display().to_string(),
        size,
        text,
        truncated,
    }
}

fn read(path: &Path, max_bytes: u64) -> io::Result<(u64, String, bool)> {
    let mut file = File::open(path)?;
    let size = file.metadata()?.len();
    let start = size.saturating_sub(max_bytes);
    file.seek(SeekFrom::Start(start))?;
    let mut bytes = Vec::new();
    file.take(max_bytes).read_to_end(&mut bytes)?;
    let mut text = String::from_utf8_lossy(&bytes).into_owned();
    if start > 0 {
        // Drop the partial first line.
        match text.find('\n') {
            Some(end) => {
                text.drain(..=end);
            }
            None => text.clear(),
        }
    }
    Ok((size, text, start > 0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_end_from_a_line_boundary() {
        let dir = std::env::temp_dir().join(format!("irodori-logs-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("sidecar.log"), "first line\nsecond line\nthird\n").unwrap();

        let whole = read_tail(&dir, LogName::Sidecar, 1024);
        assert_eq!(whole.text, "first line\nsecond line\nthird\n");
        assert!(!whole.truncated);
        assert_eq!(whole.size, 29);

        let tail = read_tail(&dir, LogName::Sidecar, 15);
        assert_eq!(tail.text, "third\n");
        assert!(tail.truncated);

        let missing = read_tail(&dir, LogName::Setup, 1024);
        assert_eq!((missing.size, missing.text.as_str()), (0, ""));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
