//! Windows: `NtCreateFile` relative to a directory handle with
//! `FILE_OPEN_REPARSE_POINT` for every step (a handle with the reparse-point
//! attribute is refused), `FILE_CREATE` to create, and `NtSetInformationFile`
//! `FileRenameInformation` with `ReplaceIfExists = FALSE` and the destination
//! directory handle as `RootDirectory` to rename. Roots must be `X:\` drive
//! paths; UNC, device (`\\.\`) and verbatim (`\\?\`) forms are refused.

use std::ffi::c_void;
use std::fs::{File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
use std::os::windows::io::{AsRawHandle, FromRawHandle};
use std::ptr::null_mut;

use crate::{Code, Error, Identity};

type Handle = *mut c_void;

#[repr(C)]
struct UnicodeString {
    length: u16,
    maximum_length: u16,
    buffer: *mut u16,
}

#[repr(C)]
struct ObjectAttributes {
    length: u32,
    root_directory: Handle,
    object_name: *mut UnicodeString,
    attributes: u32,
    security_descriptor: *mut c_void,
    security_quality_of_service: *mut c_void,
}

#[repr(C)]
struct IoStatusBlock {
    status: usize,
    information: usize,
}

#[repr(C)]
struct FileIdInfo {
    volume_serial_number: u64,
    file_id: [u8; 16],
}

#[link(name = "ntdll", kind = "raw-dylib")]
extern "system" {
    fn NtCreateFile(
        file_handle: *mut Handle,
        desired_access: u32,
        object_attributes: *mut ObjectAttributes,
        io_status_block: *mut IoStatusBlock,
        allocation_size: *mut i64,
        file_attributes: u32,
        share_access: u32,
        create_disposition: u32,
        create_options: u32,
        ea_buffer: *mut c_void,
        ea_length: u32,
    ) -> i32;
    fn NtSetInformationFile(
        file_handle: Handle,
        io_status_block: *mut IoStatusBlock,
        file_information: *mut c_void,
        length: u32,
        file_information_class: u32,
    ) -> i32;
}

#[link(name = "kernel32", kind = "raw-dylib")]
extern "system" {
    fn GetFileInformationByHandleEx(file: Handle, class: u32, info: *mut c_void, size: u32) -> i32;
}

const OBJ_CASE_INSENSITIVE: u32 = 0x40;
const SYNCHRONIZE: u32 = 0x0010_0000;
const DELETE: u32 = 0x0001_0000;
const FILE_LIST_DIRECTORY: u32 = 0x1;
const FILE_TRAVERSE: u32 = 0x20;
const FILE_READ_ATTRIBUTES: u32 = 0x80;
const FILE_GENERIC_WRITE: u32 = 0x0012_0116;
const FILE_SHARE_ALL: u32 = 0x7;
const FILE_OPEN: u32 = 1;
const FILE_CREATE: u32 = 2;
const FILE_DIRECTORY_FILE: u32 = 0x1;
const FILE_SYNCHRONOUS_IO_NONALERT: u32 = 0x20;
const FILE_NON_DIRECTORY_FILE: u32 = 0x40;
const FILE_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
const FILE_ATTRIBUTE_NORMAL: u32 = 0x80;
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
const FILE_RENAME_INFORMATION_CLASS: u32 = 10;
const FILE_ID_INFO_CLASS: u32 = 18;

/// An open directory. Closing happens on drop.
pub struct Dir(File);

fn status_error(status: i32) -> Error {
    // NTSTATUS values are defined as unsigned 32-bit codes.
    let (code, message) = match status as u32 {
        0xC000_0035 => (Code::Exists, "the destination exists"),
        0xC000_0034 | 0xC000_003A | 0xC000_0056 => {
            (Code::NotFound, "a path component does not exist")
        }
        0xC000_0103 => (Code::NotADirectory, "a path component is not a directory"),
        0x8000_002D | 0xC000_050B | 0xC000_0279 => {
            (Code::Symlink, "a path component is a reparse point")
        }
        0xC000_0033 => (Code::InvalidPath, "the filesystem refused the name"),
        0xC000_00D4 => (Code::Io, "source and destination are on different devices"),
        0xC000_00BB => (
            Code::Unsupported,
            "the filesystem does not support this operation",
        ),
        _ => (Code::Io, "filesystem operation failed"),
    };
    Error { code, message }
}

fn io_error(e: &io::Error) -> Error {
    let (code, message) = match e.raw_os_error() {
        Some(2 | 3) => (Code::NotFound, "a path component does not exist"),
        Some(80 | 183) => (Code::Exists, "the destination exists"),
        Some(267) => (Code::NotADirectory, "a path component is not a directory"),
        Some(1920 | 4390 | 4392 | 4393) => (Code::Symlink, "a path component is a reparse point"),
        _ => (Code::Io, "filesystem operation failed"),
    };
    Error { code, message }
}

fn wide(name: &str) -> Result<Vec<u16>, Error> {
    let w: Vec<u16> = name.encode_utf16().collect();
    if w.len() > 32_767 {
        return Err(Error {
            code: Code::InvalidPath,
            message: "name too long",
        });
    }
    Ok(w)
}

fn nt_open(
    parent: &Dir,
    name: &str,
    access: u32,
    attributes: u32,
    disposition: u32,
    options: u32,
) -> Result<File, Error> {
    let mut name = wide(name)?;
    let bytes = (name.len() * 2) as u16;
    let mut unicode = UnicodeString {
        length: bytes,
        maximum_length: bytes,
        buffer: name.as_mut_ptr(),
    };
    let mut object = ObjectAttributes {
        length: std::mem::size_of::<ObjectAttributes>() as u32,
        root_directory: parent.0.as_raw_handle(),
        object_name: &mut unicode,
        attributes: OBJ_CASE_INSENSITIVE,
        security_descriptor: null_mut(),
        security_quality_of_service: null_mut(),
    };
    let mut iosb = IoStatusBlock {
        status: 0,
        information: 0,
    };
    let mut handle: Handle = null_mut();
    // SAFETY: every pointer refers to a live local that outlives the call, and
    // the name buffer is not NUL-terminated, as UNICODE_STRING allows.
    let status = unsafe {
        NtCreateFile(
            &mut handle,
            access,
            &mut object,
            &mut iosb,
            null_mut(),
            attributes,
            FILE_SHARE_ALL,
            disposition,
            options | FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT,
            null_mut(),
            0,
        )
    };
    if status < 0 {
        return Err(status_error(status));
    }
    // SAFETY: a successful NtCreateFile returns a fresh handle that we own.
    Ok(unsafe { File::from_raw_handle(handle) })
}

fn refuse_reparse(file: File) -> Result<Dir, Error> {
    let attributes = file.metadata().map_err(|e| io_error(&e))?.file_attributes();
    if attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(Error {
            code: Code::Symlink,
            message: "a path component is a reparse point",
        });
    }
    Ok(Dir(file))
}

pub fn open_dir(parent: &Dir, name: &str) -> Result<Dir, Error> {
    let access = FILE_LIST_DIRECTORY | FILE_TRAVERSE | FILE_READ_ATTRIBUTES | SYNCHRONIZE;
    refuse_reparse(nt_open(
        parent,
        name,
        access,
        0,
        FILE_OPEN,
        FILE_DIRECTORY_FILE,
    )?)
}

/// Splits `X:\a\b` into the drive letter and its components.
fn root_components(path: &str) -> Result<(char, Vec<&str>), Error> {
    let invalid = || Error {
        code: Code::InvalidPath,
        message: "root must be a canonical X:\\ drive path",
    };
    let b = path.as_bytes();
    if b.len() < 3 || !b[0].is_ascii_alphabetic() || b[1] != b':' || b[2] != b'\\' {
        return Err(invalid());
    }
    let rest = &path[3..];
    if rest.is_empty() {
        return Ok((char::from(b[0]), Vec::new()));
    }
    let comps: Vec<&str> = rest.split('\\').collect();
    if comps
        .iter()
        .any(|c| c.is_empty() || *c == "." || *c == ".." || c.contains('/') || c.contains(':'))
    {
        return Err(invalid());
    }
    Ok((char::from(b[0]), comps))
}

pub fn open_root(path: &str) -> Result<Dir, Error> {
    let (drive, comps) = root_components(path)?;
    let volume = OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(format!("\\\\?\\{drive}:\\"))
        .map_err(|e| io_error(&e))?;
    let mut dir = refuse_reparse(volume)?;
    for name in comps {
        dir = open_dir(&dir, name)?;
    }
    Ok(dir)
}

pub fn canonical_root(path: &str) -> Result<String, Error> {
    root_components(path)?;
    let canonical = std::fs::canonicalize(path).map_err(|e| io_error(&e))?;
    let canonical = canonical
        .into_os_string()
        .into_string()
        .map_err(|_| Error {
            code: Code::InvalidPath,
            message: "root path is not valid Unicode",
        })?;
    let drive_path = canonical
        .strip_prefix("\\\\?\\")
        .filter(|rest| !rest.starts_with("UNC\\"))
        .ok_or(Error {
            code: Code::Unsupported,
            message: "network and device paths are refused",
        })?
        .to_owned();
    root_components(&drive_path)?;
    Ok(drive_path)
}

pub fn identity(dir: &Dir) -> Result<Identity, Error> {
    let mut info = FileIdInfo {
        volume_serial_number: 0,
        file_id: [0; 16],
    };
    // SAFETY: `info` is a FILE_ID_INFO-sized buffer that outlives the call.
    let ok = unsafe {
        GetFileInformationByHandleEx(
            dir.0.as_raw_handle(),
            FILE_ID_INFO_CLASS,
            (&mut info as *mut FileIdInfo).cast(),
            std::mem::size_of::<FileIdInfo>() as u32,
        )
    };
    if ok == 0 {
        return Err(io_error(&io::Error::last_os_error()));
    }
    Ok(Identity {
        dev: info.volume_serial_number.to_string(),
        ino: format!("{:x}", u128::from_le_bytes(info.file_id)),
    })
}

pub fn make_dir(parent: &Dir, name: &str) -> Result<(), Error> {
    nt_open(
        parent,
        name,
        FILE_LIST_DIRECTORY | SYNCHRONIZE,
        0,
        FILE_CREATE,
        FILE_DIRECTORY_FILE,
    )?;
    Ok(())
}

pub fn create_new(parent: &Dir, name: &str, content: &[u8]) -> Result<(), Error> {
    let access = FILE_GENERIC_WRITE | FILE_READ_ATTRIBUTES | SYNCHRONIZE;
    let mut file = nt_open(
        parent,
        name,
        access,
        FILE_ATTRIBUTE_NORMAL,
        FILE_CREATE,
        FILE_NON_DIRECTORY_FILE,
    )?;
    file.write_all(content).map_err(|e| io_error(&e))?;
    file.sync_all().map_err(|e| io_error(&e))?;
    Ok(())
}

pub fn rename_no_replace(from_dir: &Dir, from: &str, to_dir: &Dir, to: &str) -> Result<(), Error> {
    let source = nt_open(
        from_dir,
        from,
        DELETE | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
        0,
        FILE_OPEN,
        0,
    )?;
    let name = wide(to)?;
    // FILE_RENAME_INFORMATION: a 4-byte flags/ReplaceIfExists field padded to
    // pointer alignment, RootDirectory, a 4-byte FileNameLength, then the name.
    let ptr = std::mem::size_of::<usize>();
    let name_offset = 2 * ptr + 4;
    let struct_size = (name_offset + 2).div_ceil(ptr) * ptr;
    let length = struct_size.max(name_offset + name.len() * 2);
    let mut buffer = vec![0u64; length.div_ceil(8)];
    let base = buffer.as_mut_ptr().cast::<u8>();
    // SAFETY: the writes stay inside `buffer`, which is `length` bytes or more,
    // 8-byte aligned, and laid out as FILE_RENAME_INFORMATION expects.
    // ReplaceIfExists stays 0 (FALSE) from the zeroed buffer.
    unsafe {
        base.add(ptr)
            .cast::<Handle>()
            .write(to_dir.0.as_raw_handle());
        base.add(2 * ptr)
            .cast::<u32>()
            .write((name.len() * 2) as u32);
        std::ptr::copy_nonoverlapping(
            name.as_ptr(),
            base.add(name_offset).cast::<u16>(),
            name.len(),
        );
    }
    let mut iosb = IoStatusBlock {
        status: 0,
        information: 0,
    };
    // SAFETY: `source` is an open handle with DELETE access and `buffer`
    // holds a valid FILE_RENAME_INFORMATION of `length` bytes.
    let status = unsafe {
        NtSetInformationFile(
            source.as_raw_handle(),
            &mut iosb,
            base.cast(),
            length as u32,
            FILE_RENAME_INFORMATION_CLASS,
        )
    };
    if status < 0 {
        return Err(status_error(status));
    }
    Ok(())
}

pub fn read_file(parent: &Dir, name: &str, max_bytes: usize) -> Result<Vec<u8>, Error> {
    let file = nt_open(
        parent,
        name,
        0x0012_0089,
        0,
        FILE_OPEN,
        FILE_NON_DIRECTORY_FILE,
    )?;
    let meta = file.metadata().map_err(|e| io_error(&e))?;
    if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(Error {
            code: Code::Symlink,
            message: "read target is a reparse point",
        });
    }
    if !meta.is_file() {
        return Err(Error {
            code: Code::Io,
            message: "read target is not a regular file",
        });
    }
    let mut bytes = Vec::new();
    file.take((max_bytes + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|e| io_error(&e))?;
    if bytes.len() > max_bytes {
        return Err(Error {
            code: Code::Io,
            message: "file exceeds read limit",
        });
    }
    Ok(bytes)
}

/// FILE_ID_BOTH_DIR_INFO is requested directly on the opened directory handle.
pub fn list_dir(dir: &Dir) -> Result<(Vec<crate::Entry>, bool), Error> {
    let mut buffer = vec![0u64; 8192];
    let mut restart = true;
    let mut examined = 0;
    let mut entries = Vec::new();
    loop {
        // FileIdBothDirectoryRestartInfo (11) resets enumeration; subsequent calls use
        // FileIdBothDirectoryInfo (10). Both return FILE_ID_BOTH_DIR_INFO records.
        let class = if restart { 11 } else { 10 };
        restart = false;
        // SAFETY: buffer is aligned and writable for its full declared size; directory is live.
        let ok = unsafe {
            GetFileInformationByHandleEx(
                dir.0.as_raw_handle(),
                class,
                buffer.as_mut_ptr().cast(),
                (buffer.len() * 8) as u32,
            )
        };
        if ok == 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(18) {
                return Ok((entries, false));
            }
            return Err(io_error(&error));
        }
        let mut offset = 0;
        loop {
            const NAME_OFFSET: usize = 104;
            let capacity = buffer.len() * 8;
            if offset + NAME_OFFSET > capacity {
                return Err(Error {
                    code: Code::Io,
                    message: "directory entry is invalid",
                });
            }
            // SAFETY: records and fixed fields are inside the aligned buffer. Reads are
            // unaligned because the next-record offset is supplied by the OS.
            let record = unsafe { buffer.as_ptr().cast::<u8>().add(offset) };
            let next = unsafe { record.cast::<u32>().read_unaligned() } as usize;
            let name_bytes = unsafe { record.add(60).cast::<u32>().read_unaligned() } as usize;
            let length = if next == 0 { capacity - offset } else { next };
            if length < NAME_OFFSET
                || offset + length > capacity
                || name_bytes % 2 != 0
                || NAME_OFFSET + name_bytes > length
            {
                return Err(Error {
                    code: Code::Io,
                    message: "directory entry is invalid",
                });
            }
            // SAFETY: all filename bytes were bounds-checked above; WCHAR alignment is 2.
            let raw_name = unsafe {
                std::slice::from_raw_parts(record.add(NAME_OFFSET).cast::<u16>(), name_bytes / 2)
            };
            if let Ok(name) = String::from_utf16(raw_name) {
                if name != "." && name != ".." {
                    if examined == 1000 {
                        return Ok((entries, true));
                    }
                    examined += 1;
                    if crate::names::component(&name).is_ok() {
                        // Re-open through the same directory handle and inspect the actual
                        // object: enumeration attributes can become stale during a swap.
                        if let Ok(file) = nt_open(
                            dir,
                            &name,
                            FILE_READ_ATTRIBUTES | SYNCHRONIZE,
                            0,
                            FILE_OPEN,
                            0,
                        ) {
                            if let Ok(meta) = file.metadata() {
                                if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT == 0 {
                                    let kind = if meta.is_dir() {
                                        Some("directory")
                                    } else if meta.is_file() {
                                        Some("file")
                                    } else {
                                        None
                                    };
                                    if let Some(kind) = kind {
                                        entries.push(crate::Entry { name, kind });
                                    }
                                }
                            }
                        }
                    }
                }
            }
            if next == 0 {
                break;
            }
            offset += next;
        }
    }
}
