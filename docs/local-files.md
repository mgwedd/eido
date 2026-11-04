# Local files connector

Local files use root IDs rather than caller-supplied absolute paths. Core has no filesystem write port: `createFilesFacade` reads through the gate's `FileClient` and sends every write through `IntentClient.propose`. Reads and file content are untrusted. Read and mutation confinement both use the pinned native helper described in ADR 0006.

## Gate setup

Build and install the helper (`packages/gate/native/file-helper`, pinned Rust toolchain) into a directory controlled by the gate identity, running as the gate's user:

```sh
pnpm install:file-helper /absolute/gate-owned/bin
```

The script runs `cargo build --release --locked`, copies the binary there (mode 0700 directory, refused if group or others can write) and prints the two settings below. Re-run it after every upgrade and update the pin. Configure the printed absolute path in `EIDO_FILE_HELPER_PATH` and the lowercase SHA-256 in `EIDO_FILE_HELPER_SHA256`. Both settings are required together. The gate checks the pin before every dispatch. An upgrade requires a new pin. POSIX startup rejects non-executable or linked helper files, untrusted owners and writable install ancestors, except root-owned sticky temporary ancestors. Windows mode bits cannot prove ACL isolation: the install directory and binary must have gate/admin-only write ACLs. The install step itself is not run on the live host by this change; that remains the owner's step under #463.

Pin the `filesManifest()` connector through the ordinary signed manifest ceremony. Allowed roots are prepared and signed through the same `policy.set` ceremony on target `file-roots`, served by the local control socket and, behind the phone session, by the phone listener (`/api/gate/file-roots/...`, #574). The data-plane socket cannot change roots.

- `POST /file-roots/prepare`: `{ "roots": [{ "id": "notes", "path": "/absolute/owner-selected/notes", "trashDir": ".eido-trash" }] }`. The request carries only `id`, `path` and `trashDir` per root; the gate's own native helper captures each canonical path and directory identity. A root the helper cannot identify is refused with `422 {"code": "root_missing", "rootId": <its id>}`; the error names the id only, never the path or the helper's text.
- Review the returned canonical root paths, identities, `payloadHash` and `challenge`. Sign that exact challenge with an enrolled owner passkey.
- `POST /file-roots/complete`: `{ "roots": <returned roots object>, "authorization": { "id": <approval id>, "nonce": <nonce>, "assertion": <WebAuthn assertion> } }`. The gate first asks the helper to identify every root again; a root whose canonical path, `dev` or `ino` changed since prepare, or that is gone, is refused with `409 {"code": "root_changed", "rootId": <its id>}`, and nothing is stored or consumed. Without the helper, or when it fails, complete answers `503 unavailable`.
- `GET /file-roots` (phone listener, session required): the currently approved roots, re-verified against their signed approval and audit row; `{ "roots": [] }` when none verify.

On the phone listener a valid session is necessary but never sufficient: only a fresh owner WebAuthn assertion over the prepared challenge stores roots, exactly as on the control socket.

Create the root and its trash directory before approval. A replaced directory no longer matches its signed identity; it must be explicitly reapproved. Unsigned, replayed, changed and cross-target authorizations are refused. Root signing UI design is tracked in #467; no automatic signing is provided.

## Reads and search

The gate's data-plane socket serves `GET /file-roots` and `POST /files`. The public `createFileClient` validates responses. `/files` accepts only read/list requests over an approved root ID. Absolute paths, symlinks/reparse points, escapes and changed roots are refused by the native helper. Core adds portable relative-path syntax checks; these are not the confinement boundary.

The core facade provides `file_read_text`, `file_read_pdf_text` and `files_search(query, {root})`. Text is strict UTF-8. PDF extraction uses the existing text-layer parser; corrupt PDFs and scans requiring unavailable OCR produce typed `invalid_pdf` errors. Each read is capped at 8 MiB. Search refreshes that root's current index before searching filenames and indexed content. Walks are bounded to 128 directories, 1,000 files and 16 MiB of reads; native listings stop after 1,000 examined entries. Truncation, unreadable files and skipped directories yield explicit partial coverage. Concurrent scans of the same root share one in-flight operation. A successfully observed replacement or deletion advances/tombstones the indexed head, so superseded content does not appear in current search.

`runDataPlane(...).files` exposes the complete facade. To populate Ask's existing index periodically, set the nonsecret `EIDO_FILES_SYNC=1` on core (default off). It refreshes approved roots immediately and every minute, uses the shared database write queue, and schedules digests after ingestion. Configure a default profile entity when using the activated ledger. `EIDO_FILE_HELPER_PATH` and its pin go to the gate only; core receives neither the executable configuration nor credentials.

## Writes and recovery

`file_create`, `file_rename` and `file_move` default to auto. `file_delete` always requires signed approval and moves bytes to Eido Trash. Core returns only `{intentId}`; the receipt is not a claim that execution succeeded. Gate failures are propagated and uncertain proposals are not retried automatically.

All execution uses signed roots and exclusive/no-replace native operations. Existing destination files, including dangling links, are preserved. The executor claims each attempt durably and does not retry an unresolved upstream outcome. Successful receipts and inverse operations are audit-bound. Undo restores moves/renames, moves created files into Trash, and restores approved Trash actions without overwriting an occupied original path. Root changes, modified inverses, revoked approvals and collisions fail closed. No permanent-delete operation exists. User data stays recoverable in its current location or Trash after refusal or uncertainty.

## Validation

`pnpm verify --full` runs repository checks. The `file helper` CI matrix builds and tests the pinned Rust binary on macOS, Linux and Windows, runs native wrapper/executor tests with `EIDO_FILE_HELPER` pointing at that binary, and runs the core connector path/read/search/PDF tests. Without that environment setting, native TypeScript integration cases skip explicitly; Rust tests run through `cargo test --locked`. All fixtures and filesystem trees are synthetic.
