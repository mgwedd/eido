//! Eido's confined file helper. The gate runs it once per operation with one
//! JSON request on stdin and reads one JSON response from stdout.
//!
//! Every operation opens the approved root from the filesystem root one
//! component at a time without following links, checks the root's identity
//! against the one captured at approval, then walks to the parent directory
//! the same way and mutates only through that directory handle with a
//! no-replace primitive. There is no operation that unlinks, removes or
//! truncates anything. See docs/adr/0006-native-file-helper.md.

mod base64;
mod json;
mod names;
mod sys;

#[cfg(test)]
mod tests;

pub use sys::Dir;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Code {
    BadRequest,
    InvalidPath,
    RootChanged,
    NotFound,
    Exists,
    NotADirectory,
    Symlink,
    Io,
    Unsupported,
}

impl Code {
    pub fn as_str(self) -> &'static str {
        match self {
            Code::BadRequest => "bad_request",
            Code::InvalidPath => "invalid_path",
            Code::RootChanged => "root_changed",
            Code::NotFound => "not_found",
            Code::Exists => "exists",
            Code::NotADirectory => "not_a_directory",
            Code::Symlink => "symlink",
            Code::Io => "io",
            Code::Unsupported => "unsupported",
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct Error {
    pub code: Code,
    pub message: &'static str,
}

fn bad(message: &'static str) -> Error {
    Error {
        code: Code::BadRequest,
        message,
    }
}

#[derive(Debug, PartialEq, Eq, Clone)]
pub struct Identity {
    pub dev: String,
    pub ino: String,
}

struct Root {
    path: String,
    identity: Identity,
    trash_dir: String,
}

pub struct Entry {
    pub name: String,
    pub kind: &'static str,
}

enum Request {
    Read {
        root: Root,
        path: String,
        max_bytes: usize,
    },
    List {
        root: Root,
        path: String,
    },
    Identify {
        path: String,
    },
    Create {
        root: Root,
        path: String,
        content: Vec<u8>,
    },
    Move {
        root: Root,
        from: String,
        to: String,
    },
    Trash {
        root: Root,
        path: String,
        trash_name: String,
    },
    Restore {
        root: Root,
        trash_name: String,
        path: String,
    },
}

enum Response {
    Read(Vec<u8>),
    List {
        entries: Vec<Entry>,
        truncated: bool,
    },
    Identify {
        canonical_path: String,
        identity: Identity,
    },
    Done(&'static str),
}

/// The largest request the helper reads. The gate enforces the same bound.
pub const MAX_REQUEST_BYTES: usize = 4 * 1024 * 1024;

fn exact_keys(v: &json::Value, keys: &[&str]) -> Result<(), Error> {
    let mut found = v.keys();
    found.sort_unstable();
    let mut want = keys.to_vec();
    want.sort_unstable();
    if found != want {
        return Err(bad("unexpected or missing fields"));
    }
    Ok(())
}

fn string(v: &json::Value, key: &str) -> Result<String, Error> {
    v.get(key)
        .and_then(json::Value::as_str)
        .map(str::to_owned)
        .ok_or(bad("field must be a string"))
}

fn identity_field(v: &json::Value, key: &str) -> Result<String, Error> {
    let s = string(v, key)?;
    if s.is_empty()
        || s.len() > 40
        || !s
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(bad("identity must be lowercase hex or decimal"));
    }
    Ok(s)
}

fn root(v: &json::Value) -> Result<Root, Error> {
    let r = v.get("root").ok_or(bad("missing root"))?;
    exact_keys(r, &["path", "dev", "ino", "trashDir"])?;
    let trash_dir = string(r, "trashDir")?;
    names::trash_dir(&trash_dir)?;
    Ok(Root {
        path: string(r, "path")?,
        identity: Identity {
            dev: identity_field(r, "dev")?,
            ino: identity_field(r, "ino")?,
        },
        trash_dir,
    })
}

fn parse_request(input: &str) -> Result<Request, Error> {
    let v = json::parse(input).map_err(bad)?;
    let op = v
        .get("op")
        .and_then(json::Value::as_str)
        .ok_or(bad("missing op"))?;
    match op {
        "read" => {
            exact_keys(&v, &["op", "root", "path", "maxBytes"])?;
            let max_bytes = v
                .get("maxBytes")
                .and_then(json::Value::as_usize)
                .filter(|n| *n > 0 && *n <= 8 * 1024 * 1024)
                .ok_or(bad("invalid read limit"))?;
            Ok(Request::Read {
                root: root(&v)?,
                path: string(&v, "path")?,
                max_bytes,
            })
        }
        "list" => {
            exact_keys(&v, &["op", "root", "path"])?;
            Ok(Request::List {
                root: root(&v)?,
                path: string(&v, "path")?,
            })
        }
        "identify" => {
            exact_keys(&v, &["op", "path"])?;
            Ok(Request::Identify {
                path: string(&v, "path")?,
            })
        }
        "create" => {
            exact_keys(&v, &["op", "root", "path", "contentBase64"])?;
            let content = base64::decode(&string(&v, "contentBase64")?)
                .ok_or(bad("content is not canonical base64"))?;
            Ok(Request::Create {
                root: root(&v)?,
                path: string(&v, "path")?,
                content,
            })
        }
        "move" => {
            exact_keys(&v, &["op", "root", "from", "to"])?;
            Ok(Request::Move {
                root: root(&v)?,
                from: string(&v, "from")?,
                to: string(&v, "to")?,
            })
        }
        "trash" => {
            exact_keys(&v, &["op", "root", "path", "trashName"])?;
            Ok(Request::Trash {
                root: root(&v)?,
                path: string(&v, "path")?,
                trash_name: string(&v, "trashName")?,
            })
        }
        "restore" => {
            exact_keys(&v, &["op", "root", "trashName", "path"])?;
            Ok(Request::Restore {
                root: root(&v)?,
                trash_name: string(&v, "trashName")?,
                path: string(&v, "path")?,
            })
        }
        _ => Err(bad("unknown op")),
    }
}

#[cfg(test)]
thread_local! {
    /// Runs after every check and directory open, immediately before the
    /// mutating call, so tests can change the tree at the worst moment.
    pub(crate) static BEFORE_MUTATION: std::cell::RefCell<Option<Box<dyn FnMut()>>> =
        const { std::cell::RefCell::new(None) };
}

fn before_mutation() {
    #[cfg(test)]
    BEFORE_MUTATION.with(|hook| {
        if let Some(f) = hook.borrow_mut().as_mut() {
            f();
        }
    });
}

/// Opens the approved root and proves it is still the directory that was approved.
fn verified_root(root: &Root) -> Result<Dir, Error> {
    let changed = Error {
        code: Code::RootChanged,
        message: "root is not the approved directory",
    };
    let dir = match sys::open_root(&root.path) {
        Ok(dir) => dir,
        Err(e) if matches!(e.code, Code::NotFound | Code::Symlink | Code::NotADirectory) => {
            return Err(changed)
        }
        Err(e) => return Err(e),
    };
    if sys::identity(&dir)? != root.identity {
        return Err(changed);
    }
    Ok(dir)
}

fn existing_trash(root_dir: &Dir, root: &Root) -> Result<Option<Dir>, Error> {
    match sys::open_dir(root_dir, &root.trash_dir) {
        Ok(dir) => Ok(Some(dir)),
        Err(e) if e.code == Code::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

fn ensure_trash(root_dir: &Dir, root: &Root) -> Result<Dir, Error> {
    if let Some(dir) = existing_trash(root_dir, root)? {
        return Ok(dir);
    }
    match sys::make_dir(root_dir, &root.trash_dir) {
        Ok(()) => {}
        Err(e) if e.code == Code::Exists => {}
        Err(e) => return Err(e),
    }
    sys::open_dir(root_dir, &root.trash_dir)
}

/// User paths never reach into the trash, by name or by identity.
fn guard_user_path(
    root_dir: &Dir,
    root: &Root,
    trash: Option<&Identity>,
    comps: &[&str],
) -> Result<(), Error> {
    let into_trash = Error {
        code: Code::InvalidPath,
        message: "path is inside the trash directory",
    };
    if comps[0].eq_ignore_ascii_case(&root.trash_dir) {
        return Err(into_trash);
    }
    if let Some(trash) = trash {
        if let Ok(first) = sys::open_dir(root_dir, comps[0]) {
            if sys::identity(&first)? == *trash {
                return Err(into_trash);
            }
        }
    }
    Ok(())
}

/// Opens every directory above the last component. `None` means the parent is the root.
fn walk_parent(root_dir: &Dir, comps: &[&str]) -> Result<Option<Dir>, Error> {
    let mut current: Option<Dir> = None;
    for name in &comps[..comps.len() - 1] {
        let next = sys::open_dir(current.as_ref().unwrap_or(root_dir), name)?;
        current = Some(next);
    }
    Ok(current)
}

fn last<'a>(comps: &[&'a str]) -> &'a str {
    comps[comps.len() - 1]
}

fn trash_identity(trash: Option<&Dir>) -> Result<Option<Identity>, Error> {
    trash.map(sys::identity).transpose()
}

fn execute(request: Request) -> Result<Response, Error> {
    match request {
        Request::Read {
            root,
            path,
            max_bytes,
        } => {
            let comps = names::relative(&path)?;
            let root_dir = verified_root(&root)?;
            let trash = existing_trash(&root_dir, &root)?;
            guard_user_path(
                &root_dir,
                &root,
                trash_identity(trash.as_ref())?.as_ref(),
                &comps,
            )?;
            let parent = walk_parent(&root_dir, &comps)?;
            before_mutation();
            let bytes = sys::read_file(
                parent.as_ref().unwrap_or(&root_dir),
                last(&comps),
                max_bytes,
            )?;
            Ok(Response::Read(bytes))
        }
        Request::List { root, path } => {
            let root_dir = verified_root(&root)?;
            let trash = existing_trash(&root_dir, &root)?;
            let trash_id = trash_identity(trash.as_ref())?;
            let mut current = None;
            if !path.is_empty() {
                let comps = names::relative(&path)?;
                guard_user_path(&root_dir, &root, trash_id.as_ref(), &comps)?;
                for name in comps {
                    current = Some(sys::open_dir(current.as_ref().unwrap_or(&root_dir), name)?);
                }
            }
            before_mutation();
            let (mut entries, truncated) = sys::list_dir(current.as_ref().unwrap_or(&root_dir))?;
            if path.is_empty() {
                entries.retain(|e| !e.name.eq_ignore_ascii_case(&root.trash_dir));
            }
            entries.sort_by(|a, b| a.name.cmp(&b.name));
            Ok(Response::List { entries, truncated })
        }
        Request::Identify { path } => {
            let canonical_path = sys::canonical_root(&path)?;
            let dir = sys::open_root(&canonical_path)?;
            Ok(Response::Identify {
                canonical_path,
                identity: sys::identity(&dir)?,
            })
        }
        Request::Create {
            root,
            path,
            content,
        } => {
            let comps = names::relative(&path)?;
            let root_dir = verified_root(&root)?;
            let trash = existing_trash(&root_dir, &root)?;
            guard_user_path(
                &root_dir,
                &root,
                trash_identity(trash.as_ref())?.as_ref(),
                &comps,
            )?;
            let parent = walk_parent(&root_dir, &comps)?;
            before_mutation();
            sys::create_new(parent.as_ref().unwrap_or(&root_dir), last(&comps), &content)?;
            Ok(Response::Done("create"))
        }
        Request::Move { root, from, to } => {
            let from_comps = names::relative(&from)?;
            let to_comps = names::relative(&to)?;
            let root_dir = verified_root(&root)?;
            let trash = existing_trash(&root_dir, &root)?;
            let trash_id = trash_identity(trash.as_ref())?;
            guard_user_path(&root_dir, &root, trash_id.as_ref(), &from_comps)?;
            guard_user_path(&root_dir, &root, trash_id.as_ref(), &to_comps)?;
            let from_parent = walk_parent(&root_dir, &from_comps)?;
            let to_parent = walk_parent(&root_dir, &to_comps)?;
            before_mutation();
            sys::rename_no_replace(
                from_parent.as_ref().unwrap_or(&root_dir),
                last(&from_comps),
                to_parent.as_ref().unwrap_or(&root_dir),
                last(&to_comps),
            )?;
            Ok(Response::Done("move"))
        }
        Request::Trash {
            root,
            path,
            trash_name,
        } => {
            let comps = names::relative(&path)?;
            names::component(&trash_name)?;
            let root_dir = verified_root(&root)?;
            let trash = ensure_trash(&root_dir, &root)?;
            guard_user_path(&root_dir, &root, Some(&sys::identity(&trash)?), &comps)?;
            let parent = walk_parent(&root_dir, &comps)?;
            before_mutation();
            sys::rename_no_replace(
                parent.as_ref().unwrap_or(&root_dir),
                last(&comps),
                &trash,
                &trash_name,
            )?;
            Ok(Response::Done("trash"))
        }
        Request::Restore {
            root,
            trash_name,
            path,
        } => {
            let comps = names::relative(&path)?;
            names::component(&trash_name)?;
            let root_dir = verified_root(&root)?;
            let trash = existing_trash(&root_dir, &root)?.ok_or(Error {
                code: Code::NotFound,
                message: "trash directory is missing",
            })?;
            guard_user_path(&root_dir, &root, Some(&sys::identity(&trash)?), &comps)?;
            let parent = walk_parent(&root_dir, &comps)?;
            before_mutation();
            sys::rename_no_replace(
                &trash,
                &trash_name,
                parent.as_ref().unwrap_or(&root_dir),
                last(&comps),
            )?;
            Ok(Response::Done("restore"))
        }
    }
}

fn render(result: Result<Response, Error>) -> String {
    match result {
        Ok(Response::Read(bytes)) => format!(
            "{{\"ok\":true,\"op\":\"read\",\"contentBase64\":{}}}",
            json::quote(&base64::encode(&bytes))
        ),
        Ok(Response::List { entries, truncated }) => {
            let entries = entries
                .iter()
                .map(|e| {
                    format!(
                        "{{\"name\":{},\"kind\":{}}}",
                        json::quote(&e.name),
                        json::quote(e.kind)
                    )
                })
                .collect::<Vec<_>>()
                .join(",");
            format!(
                "{{\"ok\":true,\"op\":\"list\",\"entries\":[{}],\"truncated\":{}}}",
                entries, truncated
            )
        }
        Ok(Response::Identify {
            canonical_path,
            identity,
        }) => format!(
            "{{\"ok\":true,\"op\":\"identify\",\"canonicalPath\":{},\"dev\":{},\"ino\":{}}}",
            json::quote(&canonical_path),
            json::quote(&identity.dev),
            json::quote(&identity.ino),
        ),
        Ok(Response::Done(op)) => format!("{{\"ok\":true,\"op\":{}}}", json::quote(op)),
        Err(e) => format!(
            "{{\"ok\":false,\"code\":{},\"message\":{}}}",
            json::quote(e.code.as_str()),
            json::quote(e.message),
        ),
    }
}

/// Handles one request and returns the response line.
pub fn handle(input: &[u8]) -> String {
    let result = if input.len() > MAX_REQUEST_BYTES {
        Err(bad("request too large"))
    } else {
        std::str::from_utf8(input)
            .map_err(|_| bad("request is not UTF-8"))
            .and_then(parse_request)
            .and_then(execute)
    };
    render(result)
}
