//! Rules for the relative paths and single names a request may carry. One rule
//! set on every platform, the union of what Windows, macOS and Linux refuse, so
//! a path approved on one machine means the same file on another.

use crate::{Code, Error};

const MAX_COMPONENT_BYTES: usize = 255;
const MAX_PATH_BYTES: usize = 4096;

fn invalid(message: &'static str) -> Error {
    Error {
        code: Code::InvalidPath,
        message,
    }
}

fn reserved_device_name(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or(name).trim_end_matches(' ');
    let upper = stem.to_ascii_uppercase();
    if matches!(
        upper.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) {
        return true;
    }
    for prefix in ["COM", "LPT"] {
        if let Some(rest) = upper.strip_prefix(prefix) {
            let mut chars = rest.chars();
            if let (Some(c), None) = (chars.next(), chars.next()) {
                if matches!(c, '0'..='9' | '\u{b9}' | '\u{b2}' | '\u{b3}') {
                    return true;
                }
            }
        }
    }
    false
}

/// A Windows 8.3 short name such as `PROGRA~1` aliases another entry.
fn short_name_alias(name: &str) -> bool {
    let b = name.as_bytes();
    b.windows(2).any(|w| w[0] == b'~' && w[1].is_ascii_digit())
}

pub fn component(name: &str) -> Result<&str, Error> {
    if name.is_empty() {
        return Err(invalid("empty path component"));
    }
    if name == "." || name == ".." {
        return Err(invalid("dot path component"));
    }
    if name.len() > MAX_COMPONENT_BYTES {
        return Err(invalid("path component too long"));
    }
    if name
        .chars()
        .any(|c| (c as u32) < 0x20 || c == '\u{7f}' || "<>:\"/\\|?*".contains(c))
    {
        return Err(invalid("forbidden character in path component"));
    }
    if name.ends_with('.') || name.ends_with(' ') {
        return Err(invalid("path component ends with a dot or space"));
    }
    if reserved_device_name(name) {
        return Err(invalid("reserved device name"));
    }
    if short_name_alias(name) {
        return Err(invalid("short-name alias"));
    }
    Ok(name)
}

/// A relative path with `/` separators, split into checked components.
pub fn relative(path: &str) -> Result<Vec<&str>, Error> {
    if path.len() > MAX_PATH_BYTES {
        return Err(invalid("path too long"));
    }
    path.split('/').map(component).collect()
}

/// The trash directory name: one component of ASCII letters, digits, `.`, `_`
/// and `-`, so name comparison does not depend on Unicode case folding.
pub fn trash_dir(name: &str) -> Result<&str, Error> {
    component(name)?;
    if !name
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
    {
        return Err(invalid("trash directory name must be ASCII"));
    }
    Ok(name)
}
