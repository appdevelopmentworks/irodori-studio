//! Platform probe run before torch exists (the policy it feeds is in `policy.rs`),
//! free disk space, and process trees that die with the app. Platform-specific code
//! lives only in this module tree (golden rule 11).

use std::io;
use std::path::Path;
use std::process::{Child, Command};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

#[cfg(target_os = "macos")]
mod macos;
mod policy;
#[cfg(windows)]
mod windows;

#[cfg(target_os = "macos")]
use macos as sys;
#[cfg(windows)]
use windows as sys;

pub use policy::*;

/// Probe the machine (no torch needed). Takes well under a second.
pub fn probe() -> ProbeReport {
    #[cfg(windows)]
    {
        let nvidia = sys::probe_nvidia();
        ProbeReport {
            os: OsKind::Windows,
            recommended: windows_plan(&nvidia),
            cpu: cpu_plan(OsKind::Windows, None),
            nvidia,
            apple: None,
            blocker: None,
        }
    }
    #[cfg(target_os = "macos")]
    {
        let apple = sys::probe_apple();
        let (recommended, blocker) = mac_plan(&apple);
        ProbeReport {
            os: OsKind::Macos,
            nvidia: Vec::new(),
            apple: Some(apple),
            blocker,
            recommended,
            cpu: cpu_plan(OsKind::Macos, None),
        }
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        ProbeReport {
            os: OsKind::Other,
            nvidia: Vec::new(),
            apple: None,
            blocker: Some(Blocker::UnsupportedOs),
            recommended: cpu_plan(OsKind::Other, None),
            cpu: cpu_plan(OsKind::Other, None),
        }
    }
}

// ----- Disk ------------------------------------------------------------------------

/// Free bytes available to this user on the volume holding `path` (which may not
/// exist yet: the nearest existing ancestor is queried).
pub fn free_space(path: &Path) -> io::Result<u64> {
    let existing = path
        .ancestors()
        .find(|p| p.exists())
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "no existing ancestor"))?;
    #[cfg(any(windows, target_os = "macos"))]
    {
        sys::free_space(existing)
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = existing;
        Err(io::Error::new(io::ErrorKind::Unsupported, "free space"))
    }
}

// ----- Process trees ---------------------------------------------------------------

/// Kills a whole process tree; cheap to clone and usable from any thread (e.g. the
/// exit handler while a setup thread is blocked waiting on the child).
#[derive(Clone)]
pub struct TreeKiller {
    alive: Arc<AtomicBool>,
    #[cfg(any(windows, target_os = "macos"))]
    inner: Arc<sys::TreeHandle>,
}

impl TreeKiller {
    pub fn kill(&self) {
        if self.alive.swap(false, Ordering::SeqCst) {
            #[cfg(any(windows, target_os = "macos"))]
            self.inner.kill();
        }
    }
}

/// A child process whose whole tree dies on `kill()`, on drop, and — on Windows —
/// when the app itself dies, even by a forced quit (kill-on-close job object).
pub struct ProcessTree {
    child: Child,
    killer: TreeKiller,
}

impl ProcessTree {
    pub fn spawn(mut cmd: Command) -> io::Result<ProcessTree> {
        #[cfg(any(windows, target_os = "macos"))]
        sys::prepare_command(&mut cmd);
        let child = cmd.spawn()?;
        #[cfg(any(windows, target_os = "macos"))]
        let inner = match sys::TreeHandle::attach(&child) {
            Ok(handle) => Arc::new(handle),
            Err(err) => {
                let mut child = child;
                let _ = child.kill();
                let _ = child.wait();
                return Err(err);
            }
        };
        Ok(ProcessTree {
            child,
            killer: TreeKiller {
                alive: Arc::new(AtomicBool::new(true)),
                #[cfg(any(windows, target_os = "macos"))]
                inner,
            },
        })
    }

    pub fn child(&mut self) -> &mut Child {
        &mut self.child
    }

    pub fn killer(&self) -> TreeKiller {
        self.killer.clone()
    }

    /// Wait for the child to exit; afterwards the killer becomes a no-op, so a
    /// recycled PID or process group is never signalled.
    pub fn wait(&mut self) -> io::Result<std::process::ExitStatus> {
        let status = self.child.wait();
        self.killer.alive.store(false, Ordering::SeqCst);
        status
    }
}

impl Drop for ProcessTree {
    fn drop(&mut self) {
        self.killer.kill();
        #[cfg(not(any(windows, target_os = "macos")))]
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn free_space_uses_nearest_existing_ancestor() {
        let missing = std::env::temp_dir()
            .join("irodori-no-such-dir")
            .join("deeper");
        assert!(free_space(&missing).unwrap() > 0);
    }
}
