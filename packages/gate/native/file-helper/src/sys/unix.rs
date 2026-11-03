//! Linux and macOS: `openat` with `O_NOFOLLOW | O_DIRECTORY` for every step,
//! `O_CREAT | O_EXCL | O_NOFOLLOW` to create, and `renameat2(RENAME_NOREPLACE)`
//! (Linux) or `renameatx_np(RENAME_EXCL)` (macOS) to rename.

use std::ffi::{c_char, c_int, c_uint, CString};
use std::fs::File;
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::fs::MetadataExt;

use crate::{Code, Error, Identity};

#[cfg(target_os = "linux")]
mod consts {
    use std::ffi::c_int;
    pub type ModeT = u32;
    pub const AT_FDCWD: c_int = -100;
    pub const O_WRONLY: c_int = 0o1;
    pub const O_NONBLOCK: c_int = 0o4000;
    pub const O_CREAT: c_int = 0o100;
    pub const O_EXCL: c_int = 0o200;
    pub const O_CLOEXEC: c_int = 0o2000000;
    #[cfg(any(target_arch = "aarch64", target_arch = "arm"))]
    pub const O_DIRECTORY: c_int = 0o40000;
    #[cfg(any(target_arch = "aarch64", target_arch = "arm"))]
    pub const O_NOFOLLOW: c_int = 0o100000;
    #[cfg(any(target_arch = "x86_64", target_arch = "x86", target_arch = "riscv64"))]
    pub const O_DIRECTORY: c_int = 0o200000;
    #[cfg(any(target_arch = "x86_64", target_arch = "x86", target_arch = "riscv64"))]
    pub const O_NOFOLLOW: c_int = 0o400000;
    pub const ENOENT: i32 = 2;
    pub const EEXIST: i32 = 17;
    pub const EXDEV: i32 = 18;
    pub const ENOTDIR: i32 = 20;
    pub const ELOOP: i32 = 40;
    pub const UNSUPPORTED: [i32; 2] = [38, 95];
}

#[cfg(all(
    target_os = "linux",
    not(any(
        target_arch = "x86_64",
        target_arch = "x86",
        target_arch = "riscv64",
        target_arch = "aarch64",
        target_arch = "arm"
    ))
))]
compile_error!("open flag values for this Linux architecture are not declared");

#[cfg(target_os = "macos")]
mod consts {
    use std::ffi::c_int;
    pub type ModeT = u16;
    pub const AT_FDCWD: c_int = -2;
    pub const O_WRONLY: c_int = 0x1;
    pub const O_NONBLOCK: c_int = 0x4;
    pub const O_NOFOLLOW: c_int = 0x100;
    pub const O_CREAT: c_int = 0x200;
    pub const O_EXCL: c_int = 0x800;
    pub const O_DIRECTORY: c_int = 0x100000;
    pub const O_CLOEXEC: c_int = 0x1000000;
    pub const ENOENT: i32 = 2;
    pub const EEXIST: i32 = 17;
    pub const EXDEV: i32 = 18;
    pub const ENOTDIR: i32 = 20;
    pub const ELOOP: i32 = 62;
    pub const UNSUPPORTED: [i32; 3] = [45, 78, 102];
    pub const RENAME_EXCL: std::ffi::c_uint = 0x4;
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
compile_error!("eido-file-helper supports Linux and macOS among Unix systems");

use consts::*;

extern "C" {
    fn openat(dirfd: c_int, path: *const c_char, flags: c_int, ...) -> c_int;
    fn mkdirat(dirfd: c_int, path: *const c_char, mode: ModeT) -> c_int;
    #[cfg(target_os = "linux")]
    fn renameat2(
        olddirfd: c_int,
        oldpath: *const c_char,
        newdirfd: c_int,
        newpath: *const c_char,
        flags: c_uint,
    ) -> c_int;
    #[cfg(target_os = "macos")]
    fn renameatx_np(
        fromfd: c_int,
        from: *const c_char,
        tofd: c_int,
        to: *const c_char,
        flags: c_uint,
    ) -> c_int;
}

#[cfg(target_os = "linux")]
const RENAME_NOREPLACE: c_uint = 1;

/// An open directory. Closing happens on drop.
pub struct Dir(File);

fn error(e: &io::Error) -> Error {
    let (code, message) = match e.raw_os_error() {
        Some(ELOOP) => (Code::Symlink, "a path component is a symbolic link"),
        Some(EEXIST) => (Code::Exists, "the destination exists"),
        Some(ENOENT) => (Code::NotFound, "a path component does not exist"),
        Some(ENOTDIR) => (Code::NotADirectory, "a path component is not a directory"),
        Some(EXDEV) => (Code::Io, "source and destination are on different devices"),
        Some(c) if UNSUPPORTED.contains(&c) => (
            Code::Unsupported,
            "the filesystem does not support no-replace operations",
        ),
        _ => (Code::Io, "filesystem operation failed"),
    };
    Error { code, message }
}

fn cname(name: &str) -> Result<CString, Error> {
    CString::new(name).map_err(|_| Error {
        code: Code::InvalidPath,
        message: "path contains NUL",
    })
}

fn open_at(dirfd: c_int, name: &str, flags: c_int, mode: c_uint) -> Result<File, Error> {
    let name = cname(name)?;
    // SAFETY: `name` is a valid NUL-terminated string that outlives the call;
    // a returned non-negative fd is owned by nobody else.
    let fd = unsafe { openat(dirfd, name.as_ptr(), flags | O_CLOEXEC, mode) };
    if fd < 0 {
        return Err(error(&io::Error::last_os_error()));
    }
    // SAFETY: `fd` is a fresh descriptor that we own.
    Ok(unsafe { File::from_raw_fd(fd) })
}

pub fn open_dir(parent: &Dir, name: &str) -> Result<Dir, Error> {
    open_at(parent.0.as_raw_fd(), name, O_DIRECTORY | O_NOFOLLOW, 0).map(Dir)
}

fn root_components(path: &str) -> Result<Vec<&str>, Error> {
    let invalid = || Error {
        code: Code::InvalidPath,
        message: "root must be a canonical absolute path",
    };
    let rest = path.strip_prefix('/').ok_or_else(invalid)?;
    if rest.is_empty() {
        return Ok(Vec::new());
    }
    let comps: Vec<&str> = rest.split('/').collect();
    if comps
        .iter()
        .any(|c| c.is_empty() || *c == "." || *c == "..")
    {
        return Err(invalid());
    }
    Ok(comps)
}

pub fn open_root(path: &str) -> Result<Dir, Error> {
    let comps = root_components(path)?;
    let mut dir = Dir(open_at(AT_FDCWD, "/", O_DIRECTORY, 0)?);
    for name in comps {
        dir = open_dir(&dir, name)?;
    }
    Ok(dir)
}

pub fn canonical_root(path: &str) -> Result<String, Error> {
    root_components(path)?;
    let canonical = std::fs::canonicalize(path).map_err(|e| error(&e))?;
    let canonical = canonical
        .into_os_string()
        .into_string()
        .map_err(|_| Error {
            code: Code::InvalidPath,
            message: "root path is not UTF-8",
        })?;
    root_components(&canonical)?;
    Ok(canonical)
}

pub fn identity(dir: &Dir) -> Result<Identity, Error> {
    let meta = dir.0.metadata().map_err(|e| error(&e))?;
    Ok(Identity {
        dev: meta.dev().to_string(),
        ino: meta.ino().to_string(),
    })
}

pub fn make_dir(parent: &Dir, name: &str) -> Result<(), Error> {
    let name = cname(name)?;
    // SAFETY: `name` is a valid NUL-terminated string that outlives the call.
    if unsafe { mkdirat(parent.0.as_raw_fd(), name.as_ptr(), 0o700) } != 0 {
        return Err(error(&io::Error::last_os_error()));
    }
    Ok(())
}

pub fn create_new(parent: &Dir, name: &str, content: &[u8]) -> Result<(), Error> {
    let mut file = open_at(
        parent.0.as_raw_fd(),
        name,
        O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW,
        0o666,
    )?;
    file.write_all(content).map_err(|e| error(&e))?;
    file.sync_all().map_err(|e| error(&e))?;
    Ok(())
}

pub fn rename_no_replace(from_dir: &Dir, from: &str, to_dir: &Dir, to: &str) -> Result<(), Error> {
    let from = cname(from)?;
    let to = cname(to)?;
    let (a, b) = (from_dir.0.as_raw_fd(), to_dir.0.as_raw_fd());
    // SAFETY: both names are valid NUL-terminated strings that outlive the call
    // and both descriptors are open directories.
    #[cfg(target_os = "linux")]
    let rc = unsafe { renameat2(a, from.as_ptr(), b, to.as_ptr(), RENAME_NOREPLACE) };
    // SAFETY: as above.
    #[cfg(target_os = "macos")]
    let rc = unsafe { renameatx_np(a, from.as_ptr(), b, to.as_ptr(), RENAME_EXCL) };
    if rc != 0 {
        return Err(error(&io::Error::last_os_error()));
    }
    Ok(())
}

/// Opens the final component relative to its already anchored parent without following links.
pub fn read_file(parent: &Dir, name: &str, max_bytes: usize) -> Result<Vec<u8>, Error> {
    let file = open_at(parent.0.as_raw_fd(), name, O_NOFOLLOW | O_NONBLOCK, 0)?;
    if !file.metadata().map_err(|e| error(&e))?.is_file() {
        return Err(Error {
            code: Code::Io,
            message: "read target is not a regular file",
        });
    }
    let mut bytes = Vec::new();
    file.take((max_bytes + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|e| error(&e))?;
    if bytes.len() > max_bytes {
        return Err(Error {
            code: Code::Io,
            message: "file exceeds read limit",
        });
    }
    Ok(bytes)
}

extern "C" {
    fn fdopendir(fd: c_int) -> *mut std::ffi::c_void;
    #[cfg_attr(target_os = "linux", link_name = "readdir64")]
    fn readdir(dir: *mut std::ffi::c_void) -> *mut std::ffi::c_void;
    fn closedir(dir: *mut std::ffi::c_void) -> c_int;
    #[cfg(target_os = "macos")]
    fn __error() -> *mut c_int;
    #[cfg(target_os = "linux")]
    fn __errno_location() -> *mut c_int;
}

struct DirectoryStream(*mut std::ffi::c_void);
impl Drop for DirectoryStream {
    fn drop(&mut self) {
        // SAFETY: fdopendir gave this wrapper sole ownership of the live DIR stream.
        unsafe {
            closedir(self.0);
        }
    }
}

/// Enumerates through a DIR stream owning a fresh descriptor to the anchored directory.
pub fn list_dir(dir: &Dir) -> Result<(Vec<crate::Entry>, bool), Error> {
    use std::os::fd::IntoRawFd;
    let copy = open_at(dir.0.as_raw_fd(), ".", O_DIRECTORY | O_NOFOLLOW, 0)?;
    let fd = copy.into_raw_fd();
    // SAFETY: fd is an owned readable directory descriptor. fdopendir takes ownership on success.
    let stream = unsafe { fdopendir(fd) };
    if stream.is_null() {
        // SAFETY: fdopendir failed and did not take fd, which remains ours.
        drop(unsafe { File::from_raw_fd(fd) });
        return Err(error(&io::Error::last_os_error()));
    }
    let stream = DirectoryStream(stream);
    let mut entries = Vec::new();
    let mut examined = 0;
    loop {
        // SAFETY: these platform libc functions return this thread's errno pointer.
        #[cfg(target_os = "macos")]
        let errno = unsafe { __error() };
        #[cfg(target_os = "linux")]
        let errno = unsafe { __errno_location() };
        // SAFETY: errno points to the thread-local integer, stream is live and exclusively used.
        let raw = unsafe {
            *errno = 0;
            readdir(stream.0)
        };
        if raw.is_null() {
            // SAFETY: errno remains live in this thread.
            if unsafe { *errno } != 0 {
                return Err(error(&io::Error::last_os_error()));
            }
            return Ok((entries, false));
        }
        // libc dirent layout: ino64, offset64, record length16; macOS additionally
        // stores name length16 and type8, Linux type8. Only read bytes within d_reclen.
        #[cfg(target_os = "macos")]
        let name_offset = 21;
        #[cfg(target_os = "linux")]
        let name_offset = 19;
        // SAFETY: readdir returns a complete dirent; d_reclen is at byte16 on supported ABIs.
        let record_len =
            unsafe { raw.cast::<u8>().add(16).cast::<u16>().read_unaligned() } as usize;
        if record_len <= name_offset || record_len > 65535 {
            return Err(Error {
                code: Code::Io,
                message: "directory entry is invalid",
            });
        }
        // SAFETY: the name lies within the record length returned by libc.
        let bytes = unsafe {
            std::slice::from_raw_parts(raw.cast::<u8>().add(name_offset), record_len - name_offset)
        };
        let end = bytes.iter().position(|b| *b == 0).ok_or(Error {
            code: Code::Io,
            message: "directory entry is invalid",
        })?;
        let name = match std::str::from_utf8(&bytes[..end]) {
            Ok(name) => name,
            Err(_) => continue,
        };
        if name == "." || name == ".." {
            continue;
        }
        if examined == 1000 {
            return Ok((entries, true));
        }
        examined += 1;
        if crate::names::component(name).is_err() {
            continue;
        }
        // Open relative to the same handle. A concurrently replaced link cannot be followed.
        let file = match open_at(dir.0.as_raw_fd(), name, O_NOFOLLOW | O_NONBLOCK, 0) {
            Ok(file) => file,
            Err(_) => continue,
        };
        let meta = match file.metadata() {
            Ok(meta) => meta,
            Err(_) => continue,
        };
        let kind = if meta.is_dir() {
            "directory"
        } else if meta.is_file() {
            "file"
        } else {
            continue;
        };
        entries.push(crate::Entry {
            name: name.to_owned(),
            kind,
        });
    }
}
