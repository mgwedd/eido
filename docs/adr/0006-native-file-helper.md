# 0006: A native helper for confined local file operations

Status: accepted with #313. File execution, undo and confined reads are integrated by #23 / #461; signed root control routes are #462. See [local files](../local-files.md) for configuration and operation.

## Problem

File intents must create, move, trash and restore files only under a directory the owner approved. A check-then-act sequence in Node cannot guarantee that. `node:fs` resolves whole path strings on every call. It has no `openat`/`O_NOFOLLOW` walk from a directory handle, no no-replace rename (`fs.rename` replaces), and no handle-relative create. Between validating `root/a/b.txt` and writing it, a concurrent process can swap `a` for a symlink or junction that points outside the root. It can also plant a file or dangling link at the destination, which `rename` then silently replaces. The guarantee has to come from the operating system's handle-relative, no-replace primitives, called directly.

## Decision

The gate runs a small native helper, `packages/gate/native/file-helper`, written in Rust with no crates. Only the gate spawns it (`packages/gate/src/internal/files/file-helper.ts`). Core proposes file operations; it never calls the helper or holds a root.

- **Why native:** the primitives above are only available as OS calls. Calling them from Node would need a native addon or an FFI npm package. Either one would add install scripts and third-party code to the gate's strict allowlist.
- **Why Rust:** it is memory-safe at the FFI boundary. It cross-compiles to Linux, macOS and Windows from one source. Its std already exposes raw handles, so the platform layer is small. Swift (`apps/helper`) is macOS only.
- **Why no crates:** the helper is part of the gate's trusted base, so its supply chain must be as small as the gate's. It uses std plus hand-declared `extern` functions. Unix uses libc symbols. Windows uses `ntdll` through `raw-dylib`, so it needs no import library. `Cargo.toml` has an empty `[dependencies]`, and the committed `Cargo.lock` lists only the helper itself. CI builds with `--locked`. The JSON subset and strict base64 are implemented in-tree and tested.

## Protocol

There is one request per process. The request is one JSON object on stdin; the response is one JSON object on stdout. The helper is spawned with no arguments, an empty environment and no shell. The gate caps stdout at 64 KiB and discards stderr. The schemas `gate-file-helper-request` and `gate-file-helper-response` in `packages/schemas` are the source of truth. The gate validates the request before spawning and the reply before trusting it, with no casts. The helper's own parser refuses numbers, arrays, literals, duplicate keys and unknown fields.

| op         | request                         | success                                                  |
| ---------- | ------------------------------- | -------------------------------------------------------- |
| `identify` | `path` (absolute)               | `canonicalPath`, `dev`, `ino` (digits and lowercase hex) |
| `create`   | `root`, `path`, `contentBase64` | `{ok:true, op}`                                          |
| `move`     | `root`, `from`, `to`            | `{ok:true, op}`                                          |
| `trash`    | `root`, `path`, `trashName`     | `{ok:true, op}`                                          |
| `restore`  | `root`, `trashName`, `path`     | `{ok:true, op}`                                          |

| `read` | `root`, `path`, `maxBytes` (1–8 MiB) | `{ok:true, op, contentBase64}` |
| `list` | `root`, `path` (empty for root) | `{ok:true, op, entries:[{name,kind}], truncated}` |

A `root` is `{path, dev, ino, trashDir}`, exactly as approved. Paths in requests are relative to the root and use `/` separators. A refusal is `{ok:false, code, message}`, where `code` is one of the following: `bad_request`, `invalid_path`, `root_changed`, `not_found`, `exists`, `not_a_directory`, `symlink`, `io` or `unsupported`. The gate audits codes only, never the message.

There is no operation that unlinks, removes, truncates or replaces. A Rust test (`the_helper_source_has_no_destructive_calls`) scans the helper's source for those calls.

## How each operation stays confined

Every operation follows the same steps:

1. Open the root from the filesystem root one component at a time, refusing links and reparse points at every step.
2. Compare the opened root's device and file id with the approved `dev`/`ino`. On a mismatch, refuse with `root_changed`.
3. Walk to the parent directory the same way.
4. Mutate only through that directory handle:
   - **create:** `O_CREAT | O_EXCL | O_NOFOLLOW` (`FILE_CREATE` on Windows), then write and `fsync`. The create never opens an existing entry, so existing data cannot be overwritten. A crash mid-write leaves a new, partial file and no lost data.
   - **move:** rename with no replacement. Linux uses `renameat2(RENAME_NOREPLACE)`, macOS uses `renameatx_np(RENAME_EXCL)`, and Windows uses `FileRenameInformation` with `ReplaceIfExists = FALSE`. Any entry at the destination makes the move fail with `exists`, including a dangling link and one created after validation.
   - **trash:** a no-replace rename into `<root>/<trashDir>/<trashName>`. The bytes stay on disk. The gate picks a random UUID name and retries only on `exists`, up to three times. User paths cannot name the trash directory (case-insensitive ASCII match).
   - **restore:** a no-replace rename back from the trash. It refuses when the destination exists or the root was replaced.

Because every step after the root is relative to an already-open handle, swapping an ancestor after it was opened changes nothing: the operation stays in the directory it opened. Each mutation is a single atomic syscall, so a crash leaves the entry either at its old name or at its new one.

## Roots come from signed control state

Roots are stored in `approved_file_roots` (control-db migration 13) through one `policy.set` control ceremony on target `file-roots` (ADR 0005, `control-approvals.ts`). `prepareFileRoots` asks the helper to identify each requested directory. The owner then signs the canonical path, `dev`, `ino` and trash directory together. `approvedFileRoot` re-verifies the following on every call:

- the stored row's canonical JSON and hash;
- that it is the latest used approval for that target;
- the approval and its audit row on the chain.

A missing, tampered, replayed, stale or cross-target approval returns no root, and the operation is refused as `root_not_approved` without running the helper. A directory replaced at the same path has a new identity and fails as `root_changed`.

`policy.ts` now reads only `target = 'permissions'` approvals. Before this change, any later `policy.set` approval on another target made the permission overlay look stale.

## Provenance

- `rust-toolchain.toml` pins the compiler (1.98.1). CI builds the helper with `cargo build --release --locked`, with `panic = "abort"`, LTO and one codegen unit.
- The gate takes `{path, sha256}`. Before every spawn it hashes the binary and refuses to run it unless the hash matches the pin. A missing binary or malformed pin also refuses.
- There is a residual window between the hash check and `exec`. The pin catches a binary replaced at rest, not one swapped in during that window. The binary must therefore live in a directory that only the gate's user can write, the same requirement as the gate's own code. Installing it there, and recording its hash in the gate's configuration, is packaging work tracked in a follow-up issue.

## Platform behaviour

- **Linux:** `renameat2` requires a filesystem that supports `RENAME_NOREPLACE` (ext4, btrfs, xfs, tmpfs). Elsewhere the call fails and the helper reports `unsupported`; it does not fall back to a replacing rename.
- **macOS:** `renameatx_np(RENAME_EXCL)` is used, and APFS and HFS+ support it. `O_NOFOLLOW | O_DIRECTORY` on a symlinked component fails with `ENOTDIR` or `ELOOP`, which the helper reports as `not_a_directory` or `symlink`. Either way the operation is refused. `identify` returns the canonical path, so a root under `/var` is recorded as `/private/var`.
- **Windows:** roots must be drive paths (`X:\`); UNC, device (`\\.\`) and verbatim (`\\?\`) forms are refused. Every open uses `FILE_OPEN_REPARSE_POINT` and refuses handles with the reparse-point attribute, which covers symlinks and junctions. Identity is the volume serial number (decimal) and the 128-bit `FileIdInfo` file id (hex).
- **Names:** every platform enforces the union of what any platform refuses:
  - empty, `.` and `..` components, `\`, `:` and control characters;
  - trailing dots and spaces;
  - reserved device names (`CON`, `NUL`, `COM1`, …);
  - 8.3 short-name aliases.

  A path approved on one machine therefore means the same file on another.

## Testing

- **Rust:** `cargo test --locked` runs 30 tests on ubuntu, macOS and Windows in CI, in the `file helper` job. They cover every verb plus race tests that use hooks to swap ancestors, plant symlinks or reparse points, create destinations between validation and mutation, and replace the root. One test runs concurrent swapper threads.
- **Gate unit tests:** these mock `node:child_process`, so `pnpm verify` and the gate package tests never need cargo or the binary. They cover the wrapper (spawn options, pin, stream limits, reply parsing), the signed roots (unsigned, tampered, replayed, stale and cross-target refusal) and the audited operations (hashes only).
- **Native end-to-end:** `file-helper.native.test.ts` runs the real helper through signed roots, including a replaced root. It runs only when `EIDO_FILE_HELPER` names a binary. The CI `file helper` job sets it after the release build on all three platforms; elsewhere the test is skipped. Cargo is deliberately not a turbo task, so contributors without a Rust toolchain can still run every other check.

## Confined reads (#23)

Read opens the final regular file through its verified parent handle, refuses links and reparse points, and reads at most the requested byte limit. Listing uses an independent directory handle (`fdopendir`/`readdir` on Unix, `GetFileInformationByHandleEx` on Windows), inspects children relative to that handle, skips links and special files and excludes Eido Trash. A listing examines at most 1,000 entries and reports truncation. No reconstructed path is reopened after validation. The read stdout limit is 12 MiB; list replies are bounded to 512 KiB. The schema permits only the declared operations and bounded output.

The gate checks helper install permissions before starting file services. POSIX checks include regular executable type, ownership and non-writable ancestors; root-owned sticky temporary ancestors are allowed. Windows requires deployment ACL enforcement because POSIX mode bits do not prove it. Native TypeScript integration now also tests the executor and real gate sockets. Core connector cases run in the same three-platform CI matrix. Host installation automation remains #463.
