//! Moving the data root (D16): copy everything but rebuildable caches into an empty
//! folder, verify the copy, point the runtime venv at its new home, then switch. The
//! flow around it — stopping and starting the sidecar, settings, progress events — is
//! in commands.rs. The old folder stays until the user deletes it.
//!
//! Links are recreated, not followed: uv links a Python's minor version to its patch
//! release (a junction on Windows, a symlink on macOS), the venv's `bin/` holds symlinks
//! on macOS, and Hugging Face snapshots link to blobs. A link that pointed inside the old
//! root points inside the new one.

use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;

use crate::bootstrap::sanitize_env;
use crate::error::{AppError, ErrorCode};
use crate::paths::{self, DataPaths};
use crate::platform::{self, ProcessTree};

pub const EVENT_MOVE: &str = "app://move";

/// Rebuildable caches, relative to the root: uv's download cache (gigabytes of wheels the
/// venv does not need) and Python bytecode.
const SKIPPED: [&str; 2] = ["runtime/uv-cache", "runtime/pycache"];
/// Keep this much free on the target after the copy.
pub const MARGIN_BYTES: u64 = 512 * 1024 * 1024;
/// Proposed inside a chosen folder that is not empty.
pub const SUBFOLDER: &str = "irodori-studio-data";
/// Files at least this large are copied in chunks, so progress and cancel stay live.
const CHUNKED_FROM: u64 = 32 * 1024 * 1024;
const CHUNK: usize = 8 * 1024 * 1024;
/// Compared byte for byte after the copy: the database holds everything but the audio.
const DATABASE_FILES: [&str; 3] = [
    "irodori-studio.db",
    "irodori-studio.db-wal",
    "irodori-studio.db-shm",
];

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MovePhase {
    #[default]
    Idle,
    Stopping,
    Scanning,
    Copying,
    Verifying,
    Switching,
    Starting,
    Done,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct MoveProgress {
    pub phase: MovePhase,
    pub running: bool,
    pub from: Option<String>,
    pub to: Option<String>,
    pub done_bytes: u64,
    pub total_bytes: u64,
    pub done_files: u64,
    pub total_files: u64,
    pub error: Option<AppError>,
    /// After a successful move: the previous folder, until it is deleted or dismissed.
    pub old_root: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MoveTarget {
    pub path: String,
    pub exists: bool,
    pub free_bytes: Option<u64>,
    /// What the copy needs (caches excluded), without the safety margin.
    pub required_bytes: u64,
    pub issues: Vec<ErrorCode>,
    /// A new folder inside the chosen one, which was not empty.
    pub proposed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EntryKind {
    Dir,
    File(u64),
    /// The link's target as stored (absolute or relative).
    Link(PathBuf),
}

#[derive(Debug, Clone)]
pub struct Entry {
    pub rel: PathBuf,
    pub kind: EntryKind,
}

#[derive(Debug, Default)]
pub struct Plan {
    /// Parents before children.
    pub entries: Vec<Entry>,
    pub bytes: u64,
    pub files: u64,
}

// ----- Planning ---------------------------------------------------------------------

/// Everything under `root` that moves (caches excluded), without following links.
pub fn scan(root: &Path) -> io::Result<Plan> {
    let mut plan = Plan::default();
    walk(root, Path::new(""), &mut plan)?;
    Ok(plan)
}

fn walk(root: &Path, rel: &Path, plan: &mut Plan) -> io::Result<()> {
    let mut children = fs::read_dir(root.join(rel))?.collect::<Result<Vec<_>, _>>()?;
    children.sort_by_key(|child| child.file_name());
    for child in children {
        let rel_child = rel.join(child.file_name());
        if is_skipped(&rel_child) {
            continue;
        }
        let meta = fs::symlink_metadata(child.path())?;
        if meta.file_type().is_symlink() {
            let target = fs::read_link(child.path())?;
            plan.entries.push(Entry {
                rel: rel_child,
                kind: EntryKind::Link(target),
            });
        } else if meta.is_dir() {
            plan.entries.push(Entry {
                rel: rel_child.clone(),
                kind: EntryKind::Dir,
            });
            walk(root, &rel_child, plan)?;
        } else {
            plan.bytes += meta.len();
            plan.files += 1;
            plan.entries.push(Entry {
                rel: rel_child,
                kind: EntryKind::File(meta.len()),
            });
        }
    }
    Ok(())
}

fn is_skipped(rel: &Path) -> bool {
    SKIPPED.iter().any(|skip| rel == Path::new(skip))
}

/// Why `target` cannot receive the data root now in `current`; empty when it can.
pub fn check_target(current: &Path, target: &Path, required: u64) -> MoveTarget {
    let mut issues = Vec::new();
    let exists = target.exists();
    let invalid = target.as_os_str().is_empty()
        || !target.is_absolute()
        || (exists && !target.is_dir())
        || overlaps(current, target);
    if invalid {
        issues.push(ErrorCode::DataRootInvalid);
    } else if exists && !is_empty_dir(target) {
        issues.push(ErrorCode::DataRootNotEmpty);
    } else if !paths::can_create_in(target) {
        issues.push(ErrorCode::DataRootNotWritable);
    }
    let free_bytes = platform::free_space(target).ok();
    if free_bytes.is_some_and(|free| free < required.saturating_add(MARGIN_BYTES)) {
        issues.push(ErrorCode::DiskSpaceInsufficient);
    }
    MoveTarget {
        path: target.display().to_string(),
        exists,
        free_bytes,
        required_bytes: required,
        issues,
        proposed: false,
    }
}

/// Like `check_target`, but a chosen folder that is not empty gets a new subfolder
/// proposed instead (people tend to pick "D:\" or "Documents").
pub fn suggest_target(current: &Path, chosen: &Path, required: u64) -> MoveTarget {
    let checked = check_target(current, chosen, required);
    if checked.issues != [ErrorCode::DataRootNotEmpty] {
        return checked;
    }
    let nested = check_target(current, &chosen.join(SUBFOLDER), required);
    if nested.issues.contains(&ErrorCode::DataRootNotEmpty) {
        return checked;
    }
    MoveTarget {
        proposed: true,
        ..nested
    }
}

fn is_empty_dir(path: &Path) -> bool {
    fs::read_dir(path).is_ok_and(|mut entries| entries.next().is_none())
}

/// The same folder, or one inside the other.
pub fn overlaps(a: &Path, b: &Path) -> bool {
    let (a, b) = (comparable(a), comparable(b));
    a.starts_with(&b) || b.starts_with(&a)
}

/// A path for comparisons: the nearest existing ancestor canonicalized (links, `..`,
/// and on Windows the letter case and `\\?\` prefix), the rest appended.
fn comparable(path: &Path) -> PathBuf {
    let mut rest = Vec::new();
    let mut existing = path;
    let resolved = loop {
        if let Ok(canonical) = fs::canonicalize(existing) {
            break platform::plain_path(&canonical);
        }
        match (existing.parent(), existing.file_name()) {
            (Some(parent), Some(name)) => {
                rest.push(name.to_os_string());
                existing = parent;
            }
            _ => break path.to_path_buf(),
        }
    };
    let joined = rest.iter().rev().fold(resolved, |acc, part| acc.join(part));
    if cfg!(windows) {
        PathBuf::from(joined.to_string_lossy().to_lowercase())
    } else {
        joined
    }
}

/// `path` re-rooted from `old` to `new`; `None` when it is not under `old`.
pub fn rebase(path: &Path, old: &Path, new: &Path) -> Option<PathBuf> {
    let path = platform::plain_path(path);
    let mut rest = path.components();
    for want in old.components() {
        let got = rest.next()?;
        if !same_component(got, want) {
            return None;
        }
    }
    Some(new.join(rest.as_path()))
}

fn same_component(a: Component<'_>, b: Component<'_>) -> bool {
    if cfg!(windows) {
        a.as_os_str().to_string_lossy().to_lowercase()
            == b.as_os_str().to_string_lossy().to_lowercase()
    } else {
        a == b
    }
}

// ----- Copying ----------------------------------------------------------------------

/// Copy `plan` from `from` to `to` (which exists and is empty). `on_progress` gets
/// (bytes, files) done so far.
pub fn copy_tree(
    from: &Path,
    to: &Path,
    plan: &Plan,
    cancelled: &AtomicBool,
    on_progress: &mut dyn FnMut(u64, u64),
) -> Result<(), AppError> {
    let mut buffer = vec![0u8; CHUNK];
    let (mut bytes, mut files) = (0u64, 0u64);
    for entry in &plan.entries {
        if cancelled.load(Ordering::SeqCst) {
            return Err(AppError::with_detail(
                ErrorCode::DataMoveFailed,
                "cancelled",
            ));
        }
        let source = from.join(&entry.rel);
        let dest = to.join(&entry.rel);
        let failed = |e: io::Error| {
            AppError::with_detail(io_code(&e), format!("{}: {e}", entry.rel.display()))
        };
        match &entry.kind {
            EntryKind::Dir => fs::create_dir_all(&dest).map_err(failed)?,
            EntryKind::File(size) => {
                copy_file(&source, &dest, *size, &mut buffer, cancelled, &mut |n| {
                    bytes += n;
                    on_progress(bytes, files);
                })
                .map_err(failed)?;
                files += 1;
                on_progress(bytes, files);
            }
            EntryKind::Link(target) => {
                copy_link(&source, &dest, target, from, to).map_err(failed)?
            }
        }
    }
    Ok(())
}

fn copy_file(
    source: &Path,
    dest: &Path,
    size: u64,
    buffer: &mut [u8],
    cancelled: &AtomicBool,
    on_bytes: &mut dyn FnMut(u64),
) -> io::Result<()> {
    if size < CHUNKED_FROM {
        fs::copy(source, dest)?;
        on_bytes(size);
        return Ok(());
    }
    let mut input = File::open(source)?;
    let mut output = File::create(dest)?;
    loop {
        if cancelled.load(Ordering::SeqCst) {
            return Err(io::Error::new(io::ErrorKind::Interrupted, "cancelled"));
        }
        let read = input.read(buffer)?;
        if read == 0 {
            break;
        }
        output.write_all(&buffer[..read])?;
        on_bytes(read as u64);
    }
    output.sync_all()
}

fn copy_link(source: &Path, dest: &Path, target: &Path, from: &Path, to: &Path) -> io::Result<()> {
    // A link into the old root follows the data to the new one.
    let target = if target.is_absolute() {
        rebase(target, from, to).unwrap_or_else(|| platform::plain_path(target))
    } else {
        target.to_path_buf()
    };
    let points_to_dir = fs::metadata(source).is_ok_and(|meta| meta.is_dir());
    if points_to_dir {
        // Windows junctions need an absolute target.
        let absolute = if target.is_absolute() {
            target
        } else {
            dest.parent().unwrap_or(to).join(&target)
        };
        return platform::link_dir(dest, &absolute);
    }
    match platform::link_file(dest, &target) {
        Ok(()) => Ok(()),
        // Windows without Developer Mode: copy what the link points to.
        Err(_) if source.is_file() => fs::copy(source, dest).map(|_| ()),
        Err(err) => Err(err),
    }
}

/// Every planned entry exists in the copy with its size; the database files match byte
/// for byte.
pub fn verify(from: &Path, to: &Path, plan: &Plan) -> Result<(), AppError> {
    let mismatch = |rel: &Path, what: &str| {
        AppError::with_detail(
            ErrorCode::DataMoveFailed,
            format!("verify {}: {what}", rel.display()),
        )
    };
    for entry in &plan.entries {
        let dest = to.join(&entry.rel);
        match &entry.kind {
            EntryKind::Dir => {
                if !dest.is_dir() {
                    return Err(mismatch(&entry.rel, "missing folder"));
                }
            }
            EntryKind::File(size) => match fs::metadata(&dest) {
                Ok(meta) if meta.len() == *size => {}
                Ok(meta) => {
                    return Err(mismatch(
                        &entry.rel,
                        &format!("{} bytes instead of {size}", meta.len()),
                    ))
                }
                Err(_) => return Err(mismatch(&entry.rel, "missing file")),
            },
            EntryKind::Link(_) => {
                if fs::symlink_metadata(&dest).is_err() {
                    return Err(mismatch(&entry.rel, "missing link"));
                }
            }
        }
    }
    for name in DATABASE_FILES {
        let source = from.join(name);
        if source.is_file() && !same_contents(&source, &to.join(name)).unwrap_or(false) {
            return Err(mismatch(Path::new(name), "contents differ"));
        }
    }
    Ok(())
}

fn same_contents(a: &Path, b: &Path) -> io::Result<bool> {
    let (mut a, mut b) = (File::open(a)?, File::open(b)?);
    if a.metadata()?.len() != b.metadata()?.len() {
        return Ok(false);
    }
    let (mut buf_a, mut buf_b) = (vec![0u8; 1 << 20], vec![0u8; 1 << 20]);
    loop {
        let read = a.read(&mut buf_a)?;
        if read == 0 {
            return Ok(true);
        }
        b.read_exact(&mut buf_b[..read])?;
        if buf_a[..read] != buf_b[..read] {
            return Ok(false);
        }
    }
}

// ----- The runtime venv -------------------------------------------------------------

/// uv writes the interpreter's absolute path into the venv — `pyvenv.cfg`, the
/// `python.exe` trampoline on Windows, the `bin/` links on macOS — so let uv write them
/// again for the moved interpreter. The packages stay; nothing is downloaded.
pub fn relink_venv(uv: &Path, data: &DataPaths, python: &str) -> Result<(), AppError> {
    let failed = |detail: String| AppError::with_detail(ErrorCode::DataMoveFailed, detail);
    let mut cmd = Command::new(uv);
    cmd.arg("venv").arg(&data.venv).args([
        "--python",
        python,
        "--managed-python",
        "--no-python-downloads",
        "--allow-existing",
        "--no-config",
        "--quiet",
    ]);
    // Inherited uv settings go first, so these stay.
    sanitize_env(&mut cmd);
    cmd.env("UV_PYTHON_INSTALL_DIR", &data.python)
        .env("UV_CACHE_DIR", &data.uv_cache)
        .env("NO_COLOR", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let mut tree = ProcessTree::spawn(cmd).map_err(|e| failed(format!("uv venv: {e}")))?;
    let mut errors = String::new();
    if let Some(mut stderr) = tree.child().stderr.take() {
        let _ = stderr.read_to_string(&mut errors);
    }
    let status = tree.wait().map_err(|e| failed(format!("uv venv: {e}")))?;
    if !status.success() {
        return Err(failed(format!("uv venv: {status}: {}", errors.trim())));
    }
    Ok(())
}

/// The moved venv's Python starts, and everything it runs — the interpreter it
/// launches and its standard library — lives in the new root.
pub fn check_venv(data: &DataPaths) -> Result<(), AppError> {
    const PROBE: &str = "import os, sys\n\
        print(sys.base_prefix)\n\
        print(os.path.realpath(getattr(sys, '_base_executable', sys.executable)))\n\
        print(os.path.realpath(sys.executable))";
    let failed = |detail: String| AppError::with_detail(ErrorCode::DataMoveFailed, detail);
    let mut cmd = Command::new(data.venv_python());
    cmd.args(["-c", PROBE])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    sanitize_env(&mut cmd);
    let mut tree = ProcessTree::spawn(cmd).map_err(|e| failed(format!("venv: {e}")))?;
    let mut printed = String::new();
    if let Some(mut stdout) = tree.child().stdout.take() {
        let _ = stdout.read_to_string(&mut printed);
    }
    let status = tree.wait().map_err(|e| failed(format!("venv: {e}")))?;
    let paths: Vec<&str> = printed.lines().map(str::trim).collect();
    // Python resolves links (and a root reached through one), so compare both forms.
    let canonical = fs::canonicalize(&data.root)
        .map(|path| platform::plain_path(&path))
        .unwrap_or_else(|_| data.root.clone());
    let inside = |path: &&str| {
        let path = Path::new(path);
        rebase(path, &data.root, &data.root).is_some()
            || rebase(path, &canonical, &canonical).is_some()
    };
    if !status.success() || paths.len() != 3 || !paths.iter().all(inside) {
        return Err(failed(format!("venv: {status}: {}", paths.join(" | "))));
    }
    Ok(())
}

// ----- Cleaning up ------------------------------------------------------------------

/// Undo a copy: remove the folder if the move created it, else only its contents.
pub fn remove_copy(to: &Path, created: bool) {
    if created {
        let _ = fs::remove_dir_all(to);
        return;
    }
    if let Ok(entries) = fs::read_dir(to) {
        for entry in entries.flatten() {
            let path = entry.path();
            let is_dir = fs::symlink_metadata(&path).is_ok_and(|m| m.is_dir());
            let _ = if is_dir {
                fs::remove_dir_all(&path)
            } else {
                fs::remove_file(&path).or_else(|_| fs::remove_dir(&path))
            };
        }
    }
}

/// Only a folder that looks like one of this app's data roots is ever deleted.
pub fn looks_like_data_root(path: &Path) -> bool {
    let data = DataPaths::new(path);
    path.join(DATABASE_FILES[0]).is_file() || data.marker().is_file()
}

/// Delete the data root the app moved away from.
pub fn delete_old_root(old: &Path, current: &Path) -> Result<(), AppError> {
    if !old.is_absolute() || !old.is_dir() || overlaps(old, current) || !looks_like_data_root(old) {
        return Err(AppError::new(ErrorCode::DataRootInvalid));
    }
    fs::remove_dir_all(old)
        .map_err(|e| AppError::with_detail(ErrorCode::DataRootNotWritable, e.to_string()))
}

/// A full disk reads as such; everything else as a failed move.
fn io_code(err: &io::Error) -> ErrorCode {
    // ENOSPC on Unix; ERROR_HANDLE_DISK_FULL / ERROR_DISK_FULL on Windows.
    match err.raw_os_error() {
        Some(28) if cfg!(unix) => ErrorCode::DiskSpaceInsufficient,
        Some(39) | Some(112) if cfg!(windows) => ErrorCode::DiskSpaceInsufficient,
        _ => ErrorCode::DataMoveFailed,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Under target/, not the system temp folder: junctions into a redirected (MSIX)
    /// AppData would not resolve.
    fn temp(name: &str) -> PathBuf {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("test-tmp")
            .join(format!("irodori-move-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn sample_root(root: &Path) {
        fs::create_dir_all(root.join("voices/v1")).unwrap();
        fs::create_dir_all(root.join("history/h1")).unwrap();
        fs::create_dir_all(root.join("runtime/uv-cache/wheels")).unwrap();
        fs::create_dir_all(root.join("runtime/pycache")).unwrap();
        fs::create_dir_all(root.join("runtime/python/cpython-3.10.19")).unwrap();
        fs::create_dir_all(root.join("runtime/venv")).unwrap();
        fs::write(root.join("irodori-studio.db"), b"sqlite database bytes").unwrap();
        fs::write(
            root.join("voices/v1/voice.speaker.safetensors"),
            vec![7u8; 4096],
        )
        .unwrap();
        fs::write(root.join("history/h1/a.wav"), vec![1u8; 40_000_000]).unwrap();
        fs::write(
            root.join("runtime/uv-cache/wheels/torch.whl"),
            vec![0u8; 1000],
        )
        .unwrap();
        fs::write(root.join("runtime/pycache/x.pyc"), b"pyc").unwrap();
        fs::write(
            root.join("runtime/python/cpython-3.10.19/python.exe"),
            b"exe",
        )
        .unwrap();
        fs::write(
            root.join("runtime/venv/pyvenv.cfg"),
            format!(
                "home = {}\nimplementation = CPython\nversion_info = 3.10\n",
                root.join("runtime/python/cpython-3.10").display()
            ),
        )
        .unwrap();
        platform::link_dir(
            &root.join("runtime/python/cpython-3.10"),
            &root.join("runtime/python/cpython-3.10.19"),
        )
        .unwrap();
    }

    #[test]
    fn copies_everything_but_caches_and_rebases_links() {
        let base = temp("copy");
        let (from, to) = (base.join("old"), base.join("new"));
        sample_root(&from);
        fs::create_dir_all(&to).unwrap();

        let plan = scan(&from).unwrap();
        assert!(plan.entries.iter().all(
            |e| !e.rel.starts_with("runtime/uv-cache") && !e.rel.starts_with("runtime/pycache")
        ));
        assert_eq!(plan.files, 5);
        assert_eq!(
            plan.bytes,
            21 + 4096
                + 40_000_000
                + 3
                + (fs::metadata(from.join("runtime/venv/pyvenv.cfg"))
                    .unwrap()
                    .len())
        );

        let cancelled = AtomicBool::new(false);
        let mut seen = (0, 0);
        copy_tree(&from, &to, &plan, &cancelled, &mut |bytes, files| {
            seen = (bytes, files)
        })
        .unwrap();
        assert_eq!(seen, (plan.bytes, plan.files));
        verify(&from, &to, &plan).unwrap();
        assert!(!to.join("runtime/uv-cache").exists());

        // The minor-version link now points into the new root.
        let link = to.join("runtime/python/cpython-3.10");
        assert!(fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert!(link.join("python.exe").is_file());
        let target = platform::plain_path(&fs::read_link(&link).unwrap());
        assert!(rebase(&target, &to, &to).is_some(), "{}", target.display());

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn verify_catches_a_changed_database() {
        let base = temp("verify");
        let (from, to) = (base.join("old"), base.join("new"));
        sample_root(&from);
        fs::create_dir_all(&to).unwrap();
        let plan = scan(&from).unwrap();
        copy_tree(&from, &to, &plan, &AtomicBool::new(false), &mut |_, _| {}).unwrap();
        fs::write(to.join("irodori-studio.db"), b"sqlite database BYTES").unwrap();
        let err = verify(&from, &to, &plan).unwrap_err();
        assert_eq!(err.code, ErrorCode::DataMoveFailed);
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn cancelling_stops_the_copy() {
        let base = temp("cancel");
        let (from, to) = (base.join("old"), base.join("new"));
        sample_root(&from);
        fs::create_dir_all(&to).unwrap();
        let plan = scan(&from).unwrap();
        let err = copy_tree(&from, &to, &plan, &AtomicBool::new(true), &mut |_, _| {}).unwrap_err();
        assert_eq!(err.code, ErrorCode::DataMoveFailed);
        remove_copy(&to, false);
        assert!(to.is_dir() && is_empty_dir(&to));
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn targets_must_be_empty_and_apart() {
        let base = temp("target");
        let current = base.join("data");
        sample_root(&current);
        let inside = check_target(&current, &current.join("sub"), 1);
        assert_eq!(inside.issues, vec![ErrorCode::DataRootInvalid]);
        let same = check_target(&current, &current, 1);
        assert_eq!(same.issues, vec![ErrorCode::DataRootInvalid]);
        let parent = check_target(&current, &base, 1);
        assert_eq!(parent.issues, vec![ErrorCode::DataRootInvalid]);
        let busy = base.join("busy");
        fs::create_dir_all(&busy).unwrap();
        fs::write(busy.join("x"), b"x").unwrap();
        assert_eq!(
            check_target(&current, &busy, 1).issues,
            vec![ErrorCode::DataRootNotEmpty]
        );
        let fresh = check_target(&current, &base.join("fresh"), 1);
        assert!(fresh.issues.is_empty(), "{:?}", fresh.issues);
        let proposed = suggest_target(&current, &busy, 1);
        assert!(proposed.proposed && proposed.issues.is_empty());
        assert!(proposed.path.ends_with(SUBFOLDER));
        assert!(!suggest_target(&current, &base.join("fresh"), 1).proposed);
        let huge = check_target(&current, &base.join("fresh"), u64::MAX / 2);
        assert_eq!(huge.issues, vec![ErrorCode::DiskSpaceInsufficient]);
        assert_eq!(
            check_target(&current, Path::new("relative"), 1).issues,
            vec![ErrorCode::DataRootInvalid]
        );
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn rebases_paths_under_the_old_root_only() {
        let old = std::env::temp_dir().join("Old-Root");
        let new = std::env::temp_dir().join("new-root");
        let moved = rebase(&old.join("runtime").join("python"), &old, &new).unwrap();
        assert_eq!(moved, new.join("runtime").join("python"));
        assert!(rebase(&std::env::temp_dir().join("elsewhere"), &old, &new).is_none());
        if cfg!(windows) {
            let upper = PathBuf::from(old.to_string_lossy().to_uppercase()).join("x");
            assert_eq!(rebase(&upper, &old, &new).unwrap(), new.join("x"));
        }
    }

    #[test]
    fn deletes_only_a_data_root_apart_from_the_current_one() {
        let base = temp("delete");
        let (old, current) = (base.join("old"), base.join("current"));
        sample_root(&old);
        sample_root(&current);
        let plain = base.join("plain");
        fs::create_dir_all(&plain).unwrap();
        assert!(delete_old_root(&plain, &current).is_err());
        assert!(delete_old_root(&current, &current).is_err());
        delete_old_root(&old, &current).unwrap();
        assert!(!old.exists() && current.join("irodori-studio.db").is_file());
        let _ = fs::remove_dir_all(&base);
    }
}
