//! Windows: `nvidia-smi` probe, free disk space, and kill-on-close job objects that
//! take a child's whole process tree down with the app — even on a forced quit.

use std::io;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::AsRawHandle;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};

use windows_sys::Win32::Foundation::{CloseHandle, GENERIC_WRITE, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, GetDiskFreeSpaceExW, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
    OPEN_EXISTING,
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::IO::DeviceIoControl;

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

pub fn open_path_command(path: &Path) -> Command {
    let mut cmd = Command::new("explorer.exe");
    cmd.arg(path);
    cmd
}

/// The URL handler of the shell, without a command interpreter parsing the link.
pub fn open_url_command(url: &str) -> Command {
    let mut cmd = Command::new("rundll32.exe");
    cmd.args(["url.dll,FileProtocolHandler", url]);
    cmd
}

/// Windows 10 (1803) and later ship curl in System32.
pub fn curl() -> PathBuf {
    std::env::var_os("SystemRoot")
        .map(|root| PathBuf::from(root).join("System32").join("curl.exe"))
        .filter(|path| path.is_file())
        .unwrap_or_else(|| PathBuf::from("curl.exe"))
}

const FSCTL_SET_REPARSE_POINT: u32 = 0x0009_00A4;
const IO_REPARSE_TAG_MOUNT_POINT: u32 = 0xA000_0003;

/// A directory junction to `target` (absolute). uv links a Python's minor version to its
/// patch release this way; unlike a symbolic link it needs no special privilege.
pub fn create_junction(link: &Path, target: &Path) -> io::Result<()> {
    std::fs::create_dir(link)?;
    let result = set_mount_point(link, target);
    if result.is_err() {
        let _ = std::fs::remove_dir(link);
    }
    result
}

fn set_mount_point(link: &Path, target: &Path) -> io::Result<()> {
    // Rebuilt from components: NT paths know only `\` as a separator.
    let target: PathBuf = strip_verbatim(target).components().collect();
    if !target.is_absolute() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "junction target must be absolute",
        ));
    }
    let substitute: Vec<u16> = std::ffi::OsStr::new("\\??\\")
        .encode_wide()
        .chain(target.as_os_str().encode_wide())
        .collect();
    let print: Vec<u16> = target.as_os_str().encode_wide().collect();
    let (substitute_bytes, print_bytes) = (substitute.len() * 2, print.len() * 2);
    // Four u16 offsets/lengths, then both names, each NUL-terminated.
    let data_len = 8 + substitute_bytes + 2 + print_bytes + 2;
    let data_len16 = u16::try_from(data_len)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "junction target too long"))?;
    let mut buffer: Vec<u8> = Vec::with_capacity(8 + data_len);
    buffer.extend(IO_REPARSE_TAG_MOUNT_POINT.to_le_bytes());
    buffer.extend(data_len16.to_le_bytes());
    buffer.extend(0u16.to_le_bytes()); // reserved
    buffer.extend(0u16.to_le_bytes()); // substitute name offset
    buffer.extend((substitute_bytes as u16).to_le_bytes());
    buffer.extend(((substitute_bytes + 2) as u16).to_le_bytes()); // print name offset
    buffer.extend((print_bytes as u16).to_le_bytes());
    for unit in substitute
        .iter()
        .chain([&0])
        .chain(print.iter())
        .chain([&0])
    {
        buffer.extend(unit.to_le_bytes());
    }

    let wide: Vec<u16> = link.as_os_str().encode_wide().chain([0]).collect();
    // SAFETY: `wide` is NUL-terminated and outlives the call; the handle is checked and
    // closed on every path; `buffer` is a complete REPARSE_DATA_BUFFER of its length.
    unsafe {
        let handle = CreateFileW(
            wide.as_ptr(),
            GENERIC_WRITE,
            0,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
            std::ptr::null_mut(),
        );
        if handle == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error());
        }
        let mut returned = 0u32;
        let ok = DeviceIoControl(
            handle,
            FSCTL_SET_REPARSE_POINT,
            buffer.as_ptr().cast(),
            buffer.len() as u32,
            std::ptr::null_mut(),
            0,
            &mut returned,
            std::ptr::null_mut(),
        );
        let error = io::Error::last_os_error();
        CloseHandle(handle);
        if ok == 0 {
            return Err(error);
        }
    }
    Ok(())
}

/// `\\?\C:\x` and `\??\C:\x` (as `read_link` may return them) become `C:\x`.
pub fn strip_verbatim(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    for prefix in ["\\\\?\\UNC\\", "\\\\?\\", "\\??\\"] {
        if let Some(rest) = text.strip_prefix(prefix) {
            return if prefix.ends_with("UNC\\") {
                PathBuf::from(format!("\\\\{rest}"))
            } else {
                PathBuf::from(rest)
            };
        }
    }
    path.to_path_buf()
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
