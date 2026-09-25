//! macOS: Apple Silicon probe (`sysctl`, `sw_vers`), free disk space, and process
//! groups so a child's whole tree can be signalled. A forced quit cannot be caught
//! here; the sidecar covers that case by watching this app's pid.

use std::ffi::CString;
use std::io;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::thread;
use std::time::{Duration, Instant};

use super::AppleSilicon;

pub fn prepare_command(cmd: &mut Command) {
    // New process group whose id equals the child's pid.
    cmd.process_group(0);
}

pub fn probe_apple() -> AppleSilicon {
    AppleSilicon {
        chip: command_output("sysctl", &["-n", "machdep.cpu.brand_string"]).unwrap_or_default(),
        // 1 on Apple Silicon, also for a process running under Rosetta.
        arm64: command_output("sysctl", &["-n", "hw.optional.arm64"]).as_deref() == Some("1"),
        memory_bytes: command_output("sysctl", &["-n", "hw.memsize"])
            .and_then(|v| v.parse().ok())
            .unwrap_or(0),
        macos_version: command_output("sw_vers", &["-productVersion"]).unwrap_or_default(),
    }
}

fn command_output(program: &str, args: &[&str]) -> Option<String> {
    let out = Command::new(program).args(args).output().ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

pub fn open_path_command(path: &Path) -> Command {
    let mut cmd = Command::new("/usr/bin/open");
    cmd.arg(path);
    cmd
}

pub fn open_url_command(url: &str) -> Command {
    let mut cmd = Command::new("/usr/bin/open");
    cmd.arg(url);
    cmd
}

pub fn curl() -> PathBuf {
    PathBuf::from("/usr/bin/curl")
}

pub fn free_space(path: &Path) -> io::Result<u64> {
    let c_path = CString::new(path.as_os_str().as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "path contains NUL"))?;
    // SAFETY: `c_path` is NUL-terminated; `stat` is a valid out-parameter.
    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(c_path.as_ptr(), &mut stat) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(u64::from(stat.f_bavail) * stat.f_frsize)
}

/// The child's process group (pgid == pid, see `prepare_command`).
pub struct TreeHandle(libc::pid_t);

impl TreeHandle {
    pub fn attach(child: &Child) -> io::Result<TreeHandle> {
        libc::pid_t::try_from(child.id())
            .map(TreeHandle)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "pid out of range"))
    }

    /// SIGTERM the group, then SIGKILL whatever is still alive after a grace period.
    pub fn kill(&self) {
        // SAFETY: signalling a process group we created; ESRCH (already gone) is fine.
        unsafe {
            if libc::killpg(self.0, libc::SIGTERM) != 0 {
                return;
            }
        }
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            // SAFETY: signal 0 only checks whether the group still exists.
            if unsafe { libc::killpg(self.0, 0) } != 0 {
                return;
            }
            thread::sleep(Duration::from_millis(50));
        }
        // SAFETY: as above.
        unsafe {
            libc::killpg(self.0, libc::SIGKILL);
        }
    }
}
