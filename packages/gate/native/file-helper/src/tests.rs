//! Behaviour tests through the public `handle` entry point, plus race tests
//! that change the tree while operations run. Each test owns a fresh
//! temporary directory holding `root/` (the approved root) and `outside/`
//! (a directory a confined operation must never touch).

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

use crate::json::{self, Value};
use crate::{base64, names, Code, BEFORE_MUTATION};

const TRASH: &str = ".eido-trash";

fn text(p: &Path) -> String {
    let s = p.to_str().expect("test paths are UTF-8").to_owned();
    s.strip_prefix("\\\\?\\").map(str::to_owned).unwrap_or(s)
}

struct Fixture {
    base: PathBuf,
    root: PathBuf,
    outside: PathBuf,
    root_json: String,
}

impl Fixture {
    fn new() -> Fixture {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let tmp = PathBuf::from(text(
            &fs::canonicalize(std::env::temp_dir()).expect("temp dir"),
        ));
        let base = tmp.join(format!(
            "eido-file-helper-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = fs::remove_dir_all(&base);
        let root = base.join("root");
        let outside = base.join("outside");
        fs::create_dir_all(&root).expect("create root");
        fs::create_dir_all(&outside).expect("create outside");
        let mut f = Fixture {
            base,
            root,
            outside,
            root_json: String::new(),
        };
        f.root_json = f.approve();
        f
    }

    /// Identifies the root the way approval does and returns the request's root object.
    fn approve(&self) -> String {
        let v = call(&format!(
            "{{\"op\":\"identify\",\"path\":{}}}",
            json::quote(&text(&self.root))
        ));
        assert_eq!(field(&v, "ok"), None, "identify failed: {v:?}");
        let canonical = field(&v, "canonicalPath").expect("canonicalPath");
        assert_eq!(canonical, text(&self.root));
        format!(
            "{{\"path\":{},\"dev\":{},\"ino\":{},\"trashDir\":\"{TRASH}\"}}",
            json::quote(&canonical),
            json::quote(&field(&v, "dev").expect("dev")),
            json::quote(&field(&v, "ino").expect("ino")),
        )
    }

    fn create(&self, path: &str, content: &[u8]) -> Result<(), String> {
        outcome(&call(&format!(
            "{{\"op\":\"create\",\"root\":{},\"path\":{},\"contentBase64\":{}}}",
            self.root_json,
            json::quote(path),
            json::quote(&encode(content)),
        )))
    }

    fn mv(&self, from: &str, to: &str) -> Result<(), String> {
        outcome(&call(&format!(
            "{{\"op\":\"move\",\"root\":{},\"from\":{},\"to\":{}}}",
            self.root_json,
            json::quote(from),
            json::quote(to),
        )))
    }

    fn trash(&self, path: &str, name: &str) -> Result<(), String> {
        outcome(&call(&format!(
            "{{\"op\":\"trash\",\"root\":{},\"path\":{},\"trashName\":{}}}",
            self.root_json,
            json::quote(path),
            json::quote(name),
        )))
    }

    fn restore(&self, name: &str, path: &str) -> Result<(), String> {
        outcome(&call(&format!(
            "{{\"op\":\"restore\",\"root\":{},\"trashName\":{},\"path\":{}}}",
            self.root_json,
            json::quote(name),
            json::quote(path),
        )))
    }

    fn outside_is_empty(&self) -> bool {
        fs::read_dir(&self.outside)
            .expect("read outside")
            .next()
            .is_none()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        BEFORE_MUTATION.with(|h| *h.borrow_mut() = None);
        let _ = fs::remove_dir_all(&self.base);
    }
}

fn call(request: &str) -> Value {
    respond(request.as_bytes())
}

fn respond(request: &[u8]) -> Value {
    let response = crate::handle(request);
    // The response carries a JSON `true`/`false`, which the request parser
    // refuses; rewrite them to strings so the test can read the response.
    let readable = response
        .replace("\"ok\":true", "\"ok\":\"true\"")
        .replace("\"ok\":false", "\"ok\":\"false\"");
    let v = json::parse(&readable).expect("response is JSON");
    if field(&v, "ok").as_deref() == Some("true") {
        // Success has no `ok` field left, so `field(.., "ok") == None` means success.
        return strip_ok(v);
    }
    v
}

/// A link where a directory is expected is refused; Linux and Windows report
/// `symlink`, macOS reports `not_a_directory` for `O_NOFOLLOW | O_DIRECTORY`.
fn assert_link_refused(r: Result<(), String>) {
    match r.as_ref().map_err(String::as_str) {
        Err("symlink" | "not_a_directory") => {}
        other => panic!("expected a link refusal, got {other:?}"),
    }
}

fn strip_ok(v: Value) -> Value {
    match v {
        Value::Obj(fields) => Value::Obj(fields.into_iter().filter(|(k, _)| k != "ok").collect()),
        other => other,
    }
}

fn field(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn outcome(v: &Value) -> Result<(), String> {
    match field(v, "code") {
        Some(code) => Err(code),
        None => Ok(()),
    }
}

fn encode(bytes: &[u8]) -> String {
    const ABC: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(char::from(ABC[(n >> (18 - 6 * i)) as usize & 63]));
            } else {
                out.push('=');
            }
        }
    }
    out
}

fn err(code: Code) -> Result<(), String> {
    Err(code.as_str().to_owned())
}

#[cfg(unix)]
fn link_dir(target: &Path, link: &Path) {
    std::os::unix::fs::symlink(target, link).expect("symlink");
}
#[cfg(windows)]
fn link_dir(target: &Path, link: &Path) {
    std::os::windows::fs::symlink_dir(target, link).expect("symlink_dir");
}
#[cfg(unix)]
fn link_file(target: &Path, link: &Path) {
    std::os::unix::fs::symlink(target, link).expect("symlink");
}
#[cfg(windows)]
fn link_file(target: &Path, link: &Path) {
    std::os::windows::fs::symlink_file(target, link).expect("symlink_file");
}
#[cfg(unix)]
fn remove_dir_link(link: &Path) -> std::io::Result<()> {
    fs::remove_file(link)
}
#[cfg(windows)]
fn remove_dir_link(link: &Path) -> std::io::Result<()> {
    fs::remove_dir(link)
}

fn is_link(p: &Path) -> bool {
    fs::symlink_metadata(p)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
}

fn on_mutation(f: impl FnMut() + 'static) {
    BEFORE_MUTATION.with(|h| *h.borrow_mut() = Some(Box::new(f)));
}

// ---- protocol ----------------------------------------------------------

#[test]
fn json_refuses_shapes_outside_the_protocol() {
    assert_eq!(
        json::parse("{\"a\":\"1\",\"a\":\"2\"}"),
        Err("duplicate key")
    );
    assert_eq!(json::parse("{\"a\":1}"), Err("unsupported value"));
    assert_eq!(json::parse("{\"a\":[\"x\"]}"), Err("unsupported value"));
    assert_eq!(json::parse("{\"a\":true}"), Err("unsupported value"));
    assert_eq!(json::parse("{\"a\":\"x\"} {}"), Err("trailing data"));
    assert_eq!(json::parse("{\"a\":\"\\ud800\"}"), Err("lone surrogate"));
    assert_eq!(
        json::parse("{\"a\":\"\u{1}\"}"),
        Err("control character in string")
    );
    assert_eq!(
        json::parse("{\"a\":{\"b\":{\"c\":{\"d\":{\"e\":{\"f\":{\"g\":{\"h\":{}}}}}}}}}"),
        Err("too deep")
    );
    assert_eq!(
        json::parse("{\"k\":\"a\\u00e9\\ud83d\\ude00\\n\"}"),
        Ok(Value::Obj(vec![(
            "k".to_owned(),
            Value::Str("a\u{e9}\u{1f600}\n".to_owned())
        )]))
    );
    assert_eq!(json::quote("a\"\\\n\u{7f}"), "\"a\\\"\\\\\\u000a\\u007f\"");
}

#[test]
fn base64_is_strict() {
    assert_eq!(base64::decode("aGk="), Some(b"hi".to_vec()));
    assert_eq!(base64::decode("aGVsbG8="), Some(b"hello".to_vec()));
    assert_eq!(base64::decode(""), Some(Vec::new()));
    assert_eq!(base64::decode("aGk"), None, "unpadded");
    assert_eq!(base64::decode("aGl="), None, "non-zero trailing bits");
    assert_eq!(base64::decode("aG=k"), None, "padding inside a quad");
    assert_eq!(base64::decode("aGk=aGk="), None, "padding before the end");
    assert_eq!(base64::decode("aG k"), None, "outside the alphabet");
    assert_eq!(encode(b"hello"), "aGVsbG8=");
}

#[test]
fn names_refuse_aliases_and_traversal() {
    for bad in [
        "",
        ".",
        "..",
        "a/b",
        "a\\b",
        "a:b",
        "nul",
        "CON.txt",
        "com1",
        "LPT\u{b9}",
        "PROGRA~1",
        "dot.",
        "space ",
        "tab\t",
        "q?",
        "star*",
        "pipe|",
        "lt<",
        "gt>",
        "quote\"",
    ] {
        assert!(names::component(bad).is_err(), "{bad:?} should be refused");
    }
    assert!(names::component(&"x".repeat(256)).is_err());
    for good in [
        "notes.md",
        "Read Me",
        "caf\u{e9}",
        "a~b",
        "com10",
        "console",
        ".hidden",
    ] {
        assert_eq!(names::component(good), Ok(good));
    }
    assert!(names::relative("a//b").is_err());
    assert!(names::relative("/a").is_err());
    assert!(names::relative("a/../b").is_err());
    assert_eq!(names::relative("a/b.txt").map(|v| v.len()), Ok(2));
    assert!(names::trash_dir("tr\u{e9}sor").is_err());
    assert_eq!(names::trash_dir(".eido-trash"), Ok(".eido-trash"));
}

#[test]
fn malformed_requests_are_bad_requests() {
    let f = Fixture::new();
    let bad = |req: &str| field(&call(req), "code");
    let br = Some("bad_request".to_owned());
    assert_eq!(bad("not json"), br);
    assert_eq!(bad("{\"op\":\"unlink\",\"path\":\"a\"}"), br);
    assert_eq!(bad("{\"op\":\"identify\"}"), br);
    assert_eq!(
        bad("{\"op\":\"identify\",\"path\":\"/\",\"extra\":\"x\"}"),
        br
    );
    assert_eq!(
        bad(&format!(
            "{{\"op\":\"create\",\"root\":{},\"path\":\"a\",\"contentBase64\":\"!!\"}}",
            f.root_json
        )),
        br
    );
    let no_trash = f
        .root_json
        .replace(&format!(",\"trashDir\":\"{TRASH}\""), "");
    assert_eq!(
        bad(&format!(
            "{{\"op\":\"move\",\"root\":{no_trash},\"from\":\"a\",\"to\":\"b\"}}"
        )),
        br
    );
    let upper = f.root_json.replace("\"dev\":\"", "\"dev\":\"X");
    assert_eq!(
        bad(&format!(
            "{{\"op\":\"move\",\"root\":{upper},\"from\":\"a\",\"to\":\"b\"}}"
        )),
        br
    );
    assert_eq!(
        field(&respond(&vec![b' '; crate::MAX_REQUEST_BYTES + 1]), "code"),
        br
    );
    assert_eq!(field(&respond(&[0xff, 0xfe]), "code"), br);
}

#[test]
fn identify_returns_the_canonical_path_and_refuses_relative_paths() {
    let f = Fixture::new();
    fs::create_dir(f.root.join("sub")).unwrap();
    link_dir(&f.root.join("sub"), &f.outside.join("alias"));
    let v = call(&format!(
        "{{\"op\":\"identify\",\"path\":{}}}",
        json::quote(&text(&f.outside.join("alias")))
    ));
    assert_eq!(field(&v, "canonicalPath"), Some(text(&f.root.join("sub"))));
    let rel = call("{\"op\":\"identify\",\"path\":\"relative/dir\"}");
    assert_eq!(field(&rel, "code").as_deref(), Some("invalid_path"));
}

// ---- create ------------------------------------------------------------

#[test]
fn create_writes_exactly_the_bytes() {
    let f = Fixture::new();
    fs::create_dir(f.root.join("docs")).unwrap();
    assert_eq!(f.create("docs/note.txt", b"hello\x00world"), Ok(()));
    assert_eq!(
        fs::read(f.root.join("docs/note.txt")).unwrap(),
        b"hello\x00world"
    );
}

#[test]
fn create_never_overwrites_existing_data() {
    let f = Fixture::new();
    fs::write(f.root.join("keep.txt"), b"original").unwrap();
    assert_eq!(f.create("keep.txt", b"new"), err(Code::Exists));
    assert_eq!(fs::read(f.root.join("keep.txt")).unwrap(), b"original");
}

#[test]
fn create_does_not_follow_a_symlink_at_the_destination() {
    let f = Fixture::new();
    fs::write(f.outside.join("target.txt"), b"outside").unwrap();
    link_file(&f.outside.join("target.txt"), &f.root.join("live"));
    link_file(&f.outside.join("missing.txt"), &f.root.join("dangling"));
    assert_eq!(f.create("live", b"x"), err(Code::Exists));
    assert_eq!(f.create("dangling", b"x"), err(Code::Exists));
    assert_eq!(fs::read(f.outside.join("target.txt")).unwrap(), b"outside");
    assert!(!f.outside.join("missing.txt").exists());
}

#[test]
fn create_refuses_a_symlinked_ancestor() {
    let f = Fixture::new();
    link_dir(&f.outside, &f.root.join("docs"));
    assert_link_refused(f.create("docs/note.txt", b"x"));
    assert!(f.outside_is_empty());
}

#[test]
fn create_stays_in_the_opened_directory_when_an_ancestor_is_swapped_mid_operation() {
    let f = Fixture::new();
    fs::create_dir(f.root.join("docs")).unwrap();
    let (root, outside) = (f.root.clone(), f.outside.clone());
    on_mutation(move || {
        fs::rename(root.join("docs"), root.join("docs-moved")).unwrap();
        link_dir(&outside, &root.join("docs"));
    });
    assert_eq!(f.create("docs/note.txt", b"x"), Ok(()));
    assert!(f.outside_is_empty());
    assert_eq!(fs::read(f.root.join("docs-moved/note.txt")).unwrap(), b"x");
}

#[test]
fn create_preserves_a_destination_created_between_validation_and_mutation() {
    let f = Fixture::new();
    let root = f.root.clone();
    on_mutation(move || fs::write(root.join("race.txt"), b"theirs").unwrap());
    assert_eq!(f.create("race.txt", b"ours"), err(Code::Exists));
    assert_eq!(fs::read(f.root.join("race.txt")).unwrap(), b"theirs");
}

#[test]
fn create_refuses_a_symlink_planted_between_validation_and_mutation() {
    let f = Fixture::new();
    let (root, outside) = (f.root.clone(), f.outside.clone());
    on_mutation(move || link_file(&outside.join("planted.txt"), &root.join("race.txt")));
    assert_eq!(f.create("race.txt", b"ours"), err(Code::Exists));
    assert!(f.outside_is_empty());
}

// ---- move --------------------------------------------------------------

#[test]
fn move_renames_within_the_root() {
    let f = Fixture::new();
    fs::create_dir(f.root.join("a")).unwrap();
    fs::create_dir(f.root.join("b")).unwrap();
    fs::write(f.root.join("a/x.txt"), b"x").unwrap();
    assert_eq!(f.mv("a/x.txt", "b/y.txt"), Ok(()));
    assert!(!f.root.join("a/x.txt").exists());
    assert_eq!(fs::read(f.root.join("b/y.txt")).unwrap(), b"x");
}

#[test]
fn move_never_replaces_an_existing_destination() {
    let f = Fixture::new();
    fs::write(f.root.join("src.txt"), b"src").unwrap();
    fs::write(f.root.join("dst.txt"), b"dst").unwrap();
    assert_eq!(f.mv("src.txt", "dst.txt"), err(Code::Exists));
    assert_eq!(fs::read(f.root.join("src.txt")).unwrap(), b"src");
    assert_eq!(fs::read(f.root.join("dst.txt")).unwrap(), b"dst");
}

#[test]
fn move_never_replaces_a_symlink_destination_dangling_or_not() {
    let f = Fixture::new();
    fs::write(f.root.join("src.txt"), b"src").unwrap();
    fs::write(f.outside.join("target.txt"), b"outside").unwrap();
    link_file(&f.outside.join("target.txt"), &f.root.join("live"));
    link_file(&f.outside.join("missing.txt"), &f.root.join("dangling"));
    assert_eq!(f.mv("src.txt", "live"), err(Code::Exists));
    assert_eq!(f.mv("src.txt", "dangling"), err(Code::Exists));
    assert!(is_link(&f.root.join("live")) && is_link(&f.root.join("dangling")));
    assert_eq!(fs::read(f.root.join("src.txt")).unwrap(), b"src");
    assert_eq!(fs::read(f.outside.join("target.txt")).unwrap(), b"outside");
    assert!(!f.outside.join("missing.txt").exists());
}

#[test]
fn move_preserves_a_destination_created_between_validation_and_mutation() {
    let f = Fixture::new();
    fs::write(f.root.join("src.txt"), b"src").unwrap();
    let root = f.root.clone();
    on_mutation(move || fs::write(root.join("dst.txt"), b"theirs").unwrap());
    assert_eq!(f.mv("src.txt", "dst.txt"), err(Code::Exists));
    assert_eq!(fs::read(f.root.join("dst.txt")).unwrap(), b"theirs");
    assert_eq!(fs::read(f.root.join("src.txt")).unwrap(), b"src");
}

#[test]
fn move_preserves_a_dangling_symlink_planted_between_validation_and_mutation() {
    let f = Fixture::new();
    fs::write(f.root.join("src.txt"), b"src").unwrap();
    let (root, outside) = (f.root.clone(), f.outside.clone());
    on_mutation(move || link_file(&outside.join("missing.txt"), &root.join("dst.txt")));
    assert_eq!(f.mv("src.txt", "dst.txt"), err(Code::Exists));
    assert!(is_link(&f.root.join("dst.txt")));
    assert!(f.outside_is_empty());
}

#[test]
fn move_stays_in_the_opened_directory_when_the_destination_ancestor_is_swapped() {
    let f = Fixture::new();
    fs::create_dir(f.root.join("dst")).unwrap();
    fs::write(f.root.join("src.txt"), b"src").unwrap();
    let (root, outside) = (f.root.clone(), f.outside.clone());
    on_mutation(move || {
        fs::rename(root.join("dst"), root.join("dst-moved")).unwrap();
        link_dir(&outside, &root.join("dst"));
    });
    assert_eq!(f.mv("src.txt", "dst/out.txt"), Ok(()));
    assert!(f.outside_is_empty());
    assert_eq!(fs::read(f.root.join("dst-moved/out.txt")).unwrap(), b"src");
}

#[test]
fn move_refuses_symlinked_ancestors_on_either_side() {
    let f = Fixture::new();
    fs::write(f.outside.join("secret.txt"), b"secret").unwrap();
    link_dir(&f.outside, &f.root.join("out"));
    fs::write(f.root.join("src.txt"), b"src").unwrap();
    assert_link_refused(f.mv("out/secret.txt", "stolen.txt"));
    assert_link_refused(f.mv("src.txt", "out/src.txt"));
    assert_eq!(fs::read(f.outside.join("secret.txt")).unwrap(), b"secret");
    assert!(!f.outside.join("src.txt").exists());
}

// ---- trash and restore -------------------------------------------------

#[test]
fn trash_keeps_the_bytes_and_restore_puts_them_back() {
    let f = Fixture::new();
    fs::create_dir(f.root.join("docs")).unwrap();
    fs::write(f.root.join("docs/old.txt"), b"keep me").unwrap();
    assert_eq!(f.trash("docs/old.txt", "id1-old.txt"), Ok(()));
    assert!(!f.root.join("docs/old.txt").exists());
    assert_eq!(
        fs::read(f.root.join(TRASH).join("id1-old.txt")).unwrap(),
        b"keep me"
    );
    assert_eq!(f.restore("id1-old.txt", "docs/old.txt"), Ok(()));
    assert_eq!(fs::read(f.root.join("docs/old.txt")).unwrap(), b"keep me");
    assert!(!f.root.join(TRASH).join("id1-old.txt").exists());
}

#[test]
fn trash_never_replaces_an_entry_with_the_same_name() {
    let f = Fixture::new();
    fs::write(f.root.join("a.txt"), b"first").unwrap();
    fs::write(f.root.join("b.txt"), b"second").unwrap();
    assert_eq!(f.trash("a.txt", "same"), Ok(()));
    assert_eq!(f.trash("b.txt", "same"), err(Code::Exists));
    assert_eq!(fs::read(f.root.join(TRASH).join("same")).unwrap(), b"first");
    assert_eq!(fs::read(f.root.join("b.txt")).unwrap(), b"second");
}

#[test]
fn restore_refuses_to_replace_a_file_that_took_the_old_name() {
    let f = Fixture::new();
    fs::write(f.root.join("a.txt"), b"old").unwrap();
    assert_eq!(f.trash("a.txt", "t-a.txt"), Ok(()));
    fs::write(f.root.join("a.txt"), b"newer").unwrap();
    assert_eq!(f.restore("t-a.txt", "a.txt"), err(Code::Exists));
    assert_eq!(fs::read(f.root.join("a.txt")).unwrap(), b"newer");
    assert_eq!(
        fs::read(f.root.join(TRASH).join("t-a.txt")).unwrap(),
        b"old"
    );
}

#[test]
fn restore_refuses_a_collision_created_between_validation_and_mutation() {
    let f = Fixture::new();
    fs::write(f.root.join("a.txt"), b"old").unwrap();
    assert_eq!(f.trash("a.txt", "t-a.txt"), Ok(()));
    let root = f.root.clone();
    on_mutation(move || fs::write(root.join("a.txt"), b"theirs").unwrap());
    assert_eq!(f.restore("t-a.txt", "a.txt"), err(Code::Exists));
    assert_eq!(fs::read(f.root.join("a.txt")).unwrap(), b"theirs");
    assert_eq!(
        fs::read(f.root.join(TRASH).join("t-a.txt")).unwrap(),
        b"old"
    );
}

#[test]
fn user_paths_cannot_reach_into_the_trash() {
    let f = Fixture::new();
    fs::write(f.root.join("a.txt"), b"a").unwrap();
    assert_eq!(f.trash("a.txt", "t-a"), Ok(()));
    assert_eq!(f.create(".eido-trash/x", b"x"), err(Code::InvalidPath));
    assert_eq!(f.create(".EIDO-TRASH/x", b"x"), err(Code::InvalidPath));
    assert_eq!(f.mv(".eido-trash/t-a", "stolen"), err(Code::InvalidPath));
    assert_eq!(f.mv(".eido-trash", "elsewhere"), err(Code::InvalidPath));
    assert_eq!(f.trash(".eido-trash", "t-trash"), err(Code::InvalidPath));
    assert_eq!(f.restore("t-a", ".eido-trash/b"), err(Code::InvalidPath));
    assert_eq!(fs::read(f.root.join(TRASH).join("t-a")).unwrap(), b"a");
}

#[test]
fn a_trash_directory_replaced_by_a_symlink_is_refused() {
    let f = Fixture::new();
    link_dir(&f.outside, &f.root.join(TRASH));
    fs::write(f.root.join("a.txt"), b"a").unwrap();
    assert_link_refused(f.trash("a.txt", "t-a"));
    assert!(f.outside_is_empty());
    assert_eq!(fs::read(f.root.join("a.txt")).unwrap(), b"a");
}

// ---- root identity -----------------------------------------------------

#[test]
fn a_replaced_root_fails_closed_for_every_verb() {
    let f = Fixture::new();
    fs::write(f.root.join("a.txt"), b"a").unwrap();
    assert_eq!(f.trash("a.txt", "t-a"), Ok(()));
    fs::rename(&f.root, f.base.join("root-old")).unwrap();
    fs::create_dir(&f.root).unwrap();
    fs::write(f.root.join("b.txt"), b"b").unwrap();
    assert_eq!(f.create("c.txt", b"c"), err(Code::RootChanged));
    assert_eq!(f.mv("b.txt", "d.txt"), err(Code::RootChanged));
    assert_eq!(f.trash("b.txt", "t-b"), err(Code::RootChanged));
    assert_eq!(f.restore("t-a", "a.txt"), err(Code::RootChanged));
    assert_eq!(fs::read_dir(&f.root).unwrap().count(), 1);
}

#[test]
fn a_root_replaced_by_a_symlink_to_itself_fails_closed() {
    let f = Fixture::new();
    fs::rename(&f.root, f.base.join("root-real")).unwrap();
    link_dir(&f.base.join("root-real"), &f.root);
    assert_eq!(f.create("c.txt", b"c"), err(Code::RootChanged));
    assert!(!f.base.join("root-real/c.txt").exists());
}

#[test]
fn a_root_swapped_for_a_symlink_mid_operation_still_writes_to_the_approved_directory() {
    let f = Fixture::new();
    let (base, root, outside) = (f.base.clone(), f.root.clone(), f.outside.clone());
    on_mutation(move || {
        fs::rename(&root, base.join("root-moved")).unwrap();
        link_dir(&outside, &root);
    });
    assert_eq!(f.create("c.txt", b"c"), Ok(()));
    assert!(f.outside_is_empty());
    assert_eq!(fs::read(f.base.join("root-moved/c.txt")).unwrap(), b"c");
}

// ---- concurrency stress ------------------------------------------------

/// A second thread keeps swapping `docs` for a symlink to `outside` and back
/// while this thread runs every verb through `docs`. Whatever interleaving
/// happens, nothing may appear outside the root and every operation that
/// reports success must have its result inside the root.
#[test]
fn concurrent_ancestor_swaps_never_escape_the_root() {
    let f = Fixture::new();
    let docs = f.root.join("docs");
    let parked = f.root.join("docs-real");
    fs::create_dir(&docs).unwrap();
    let stop = Arc::new(AtomicBool::new(false));
    let swaps = Arc::new(AtomicUsize::new(0));
    let swapper = {
        let (docs, parked, outside, stop, swaps) = (
            docs.clone(),
            parked.clone(),
            f.outside.clone(),
            stop.clone(),
            swaps.clone(),
        );
        std::thread::spawn(move || {
            while !stop.load(Ordering::SeqCst) {
                if fs::rename(&docs, &parked).is_err() {
                    std::thread::yield_now();
                    continue;
                }
                #[cfg(unix)]
                let linked = std::os::unix::fs::symlink(&outside, &docs).is_ok();
                #[cfg(windows)]
                let linked = std::os::windows::fs::symlink_dir(&outside, &docs).is_ok();
                std::thread::yield_now();
                if linked {
                    while remove_dir_link(&docs).is_err() {
                        std::thread::yield_now();
                    }
                }
                while fs::rename(&parked, &docs).is_err() {
                    std::thread::yield_now();
                }
                swaps.fetch_add(1, Ordering::SeqCst);
            }
        })
    };
    let mut created = Vec::new();
    let mut moved = Vec::new();
    let mut trashed = Vec::new();
    for i in 0..400 {
        let name = format!("docs/f{i}");
        if f.create(&name, b"data").is_ok() {
            created.push(i);
            match i % 3 {
                0 if f.mv(&name, &format!("docs/g{i}")).is_ok() => moved.push(i),
                1 if f.trash(&name, &format!("t{i}")).is_ok() => trashed.push(i),
                _ => {}
            }
        }
    }
    stop.store(true, Ordering::SeqCst);
    swapper.join().unwrap();
    assert!(swaps.load(Ordering::SeqCst) > 0, "the swapper never ran");
    assert!(!created.is_empty(), "no create succeeded");
    assert!(f.outside_is_empty(), "an operation escaped the root");
    for i in created {
        let at = if moved.contains(&i) {
            docs.join(format!("g{i}"))
        } else if trashed.contains(&i) {
            f.root.join(TRASH).join(format!("t{i}"))
        } else {
            docs.join(format!("f{i}"))
        };
        assert_eq!(
            fs::read(&at).ok().as_deref(),
            Some(&b"data"[..]),
            "missing {at:?}"
        );
    }
}

// ---- no destructive verbs ---------------------------------------------

/// The helper's own source must not call anything that unlinks, removes or
/// truncates. Tests (this file) clean up their temp dirs and are excluded.
#[test]
fn the_helper_source_has_no_destructive_calls() {
    let sources = [
        include_str!("lib.rs"),
        include_str!("main.rs"),
        include_str!("json.rs"),
        include_str!("base64.rs"),
        include_str!("names.rs"),
        include_str!("sys/mod.rs"),
        include_str!("sys/unix.rs"),
        include_str!("sys/windows.rs"),
    ];
    let banned = [
        "unlink",
        "rmdir",
        "remove_file",
        "remove_dir",
        "truncate",
        "set_len",
        "FILE_DELETE_ON_CLOSE",
        "DeleteFile",
        "RemoveDirectory",
        "FileDispositionInformation",
        "O_TRUNC",
        "FILE_OVERWRITE",
        "FILE_SUPERSEDE",
        "ReplaceIfExists = 1",
        "RENAME_EXCHANGE",
    ];
    for source in sources {
        let code: String = source
            .lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");
        for word in banned {
            assert!(!code.contains(word), "helper source contains {word}");
        }
    }
}
