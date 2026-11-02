//! Platform layer. Each platform provides the same handle-relative primitives:
//!
//! - `canonical_root`: the canonical absolute path of an existing directory.
//! - `open_root`: open an absolute path one component at a time from the
//!   filesystem root, refusing links and reparse points at every step.
//! - `open_dir`: open one child directory of a handle, refusing links.
//! - `identity`: the device (volume) and inode (file id) of a handle.
//! - `make_dir`, `create_new`: create a child that must not exist yet.
//! - `rename_no_replace`: rename between two directory handles, failing if
//!   the destination name exists in any form, including a dangling link.

#[cfg(unix)]
mod unix;
#[cfg(unix)]
pub use unix::*;

#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use windows::*;

#[cfg(not(any(unix, windows)))]
compile_error!("eido-file-helper supports Linux, macOS and Windows only");
