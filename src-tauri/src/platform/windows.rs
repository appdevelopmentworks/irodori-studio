//! Windows: `nvidia-smi` probe, free disk space, and kill-on-close job objects that
//! take a child's whole process tree down with the app — even on a forced quit.

use std::io;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::AsRawHandle;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};

use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};

use super::{parse_nvidia_smi, NvidiaGpu};

/// Keep child console windows from flashing on screen.
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub fn prepare_command(cmd: &mut Command) {
    cmd.creation_flags(CREATE_NO_WINDOW);
}

/// NVIDIA GPUs via `nvidia-smi` (installed with the driver). Empty when there is no
/// NVIDIA driver or the tool fails — the policy then chooses explicit CPU mode.
pub fn probe_nvidia() -> Vec<NvidiaGpu> {
    for exe in nvidia_smi_candidates() {
        let mut cmd = Command::new(&exe);
        cmd.args([
            "--query-gpu=index,name,compute_cap,memory.total,driver_version",
            "--format=csv,noheader,nounits",
        ]);
        prepare_command(&mut cmd);
        match cmd.output() {
            Ok(out) if out.status.success() => {
                return parse_nvidia_smi(&String::from_utf8_lossy(&out.stdout));
            }
            Ok(_) => return Vec::new(),
            Err(_) => continue,
        }
    }
    Vec::new()
}

fn nvidia_smi_candidates() -> Vec<PathBuf> {
    let mut candidates = vec![PathBuf::from("nvidia-smi")];
    if let Some(program_files) = std::env::var_os("ProgramFiles") {
        candidates.push(
            PathBuf::from(program_files)
                .join("NVIDIA Corporation")
                .join("NVSMI")
                .join("nvidia-smi.exe"),
        );
    }
    candidates
}

pub fn free_space(path: &Path) -> io::Result<u64> {
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain([0]).collect();
    let mut available: u64 = 0;
    // SAFETY: `wide` is NUL-terminated and outlives the call; the out-pointer is valid.
    let ok = unsafe {
        GetDiskFreeSpaceExW(
            wide.as_ptr(),
            &mut available,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(available)
}

/// A job object with KILL_ON_JOB_CLOSE holding one child's process tree.
pub struct TreeHandle(HANDLE);

// SAFETY: a job handle may be used and closed from any thread; this type owns it.
unsafe impl Send for TreeHandle {}
unsafe impl Sync for TreeHandle {}

impl TreeHandle {
    pub fn attach(child: &Child) -> io::Result<TreeHandle> {
        // SAFETY: plain Win32 calls on handles this function owns or borrows; the job
        // is closed on every error path, and on success owned by the returned value.
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return Err(io::Error::last_os_error());
            }
            let handle = TreeHandle(job);
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                std::ptr::addr_of!(info).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if ok == 0 {
                return Err(io::Error::last_os_error());
            }
            if AssignProcessToJobObject(job, child.as_raw_handle() as HANDLE) == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(handle)
        }
    }

    pub fn kill(&self) {
        // SAFETY: the job handle is valid until drop.
        unsafe {
            TerminateJobObject(self.0, 1);
        }
    }
}

impl Drop for TreeHandle {
    fn drop(&mut self) {
        // SAFETY: owned handle, closed exactly once. Closing a kill-on-close job also
        // terminates anything still running in it.
        unsafe {
            CloseHandle(self.0);
        }
    }
}
