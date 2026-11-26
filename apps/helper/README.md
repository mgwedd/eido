# Eido Helper

The macOS 14+ native adapter for Apple Calendar and Reminders, tracked by #749
(part of #79). It uses EventKit and contains no network client, credentials,
delete operation, or package dependencies. In request mode the gate starts a fresh
process for each operation, with private anonymous stdin/stdout pipes, and checks
the response against the shared schemas. Read operations reach it through the
gate's read client; writes run only after the gate verifies signed approval. In
[session bridge mode](#session-bridge-mode) (#825) the same executable runs as an
agent in the owner's login session and serves a fixed table of operations on a
Unix socket to the gate's OS user only.

## Build and permission setup

From the repository root:

```sh
swift build --package-path apps/helper -c release
swift test --package-path apps/helper
```

The executable is `apps/helper/.build/release/eido-helper`. Its executable Mach-O
contains an embedded Info.plist with the EventKit full-access privacy descriptions.
Install it as the gate's OS user into a directory that user owns, with directory
mode `0700` and executable mode `0500`. For a gate running as the current user:

```sh
install -d -m 0700 "$HOME/Library/Application Support/eido-dev/helper"
install -m 0500 apps/helper/.build/release/eido-helper "$HOME/Library/Application Support/eido-dev/helper/eido-helper"
```

Configure **the gate's** launch environment with `EIDO_EVENTKIT_HELPER` set to
that installed binary's absolute path and `EIDO_EVENTKIT_HELPER_SHA256` set to its
lowercase SHA-256. The two are set together; the gate will not start with only one.

```sh
shasum -a 256 "$HOME/Library/Application Support/eido-dev/helper/eido-helper"
```

Before every launch the gate hashes the resolved binary and refuses to run it when
the hash differs from the pin, so a rebuilt or replaced Helper needs a new pin.
The gate refuses a relative path, symlink,
non-regular file, executable owned by another user, or group/world-writable file.
Its containing directories must be owned by the gate user or root and must prevent
replacement by another OS user. Gate/root-owned sticky directories such as
`/private/tmp` are allowed. The gate checks both the configured location and its
resolved target, then launches the resolved executable. Directory aliases such as
Swift's `.build/release` remain usable when their containing directories are safe.
When using stack commands, these gate-only keys can also be stored in the local
`stack.env`; the settings API refuses changes to the executable path and its pin.
Do not configure a Helper socket: core uses the gate's HTTP data-plane read routes
`GET /apple/calendars`, `/apple/reminder-lists`, `/apple/events`, and
`/apple/reminders`; only the gate launches the native executable. The Apple read
client allows 35 seconds per call, covering the native runner's 30-second limit.
The gate runs at most four Helper processes at once and refuses a call beyond that
with `unavailable` instead of queueing it. Each Helper runs in its own process
group, and a timeout kills the whole group, including anything the Helper started.
If the gate dies mid-request, the Helper notices its parent exit and quits at
once; `--authorize` is not watched.
(ADR 0006, #773).

The Helper needs full Calendar and Reminder access. The owner explicitly grants
access to the **exact installed binary** before enabling the connector:

```sh
"$HOME/Library/Application Support/eido-dev/helper/eido-helper" --authorize
```

This setup command may display the macOS privacy prompts. Its only stdout is
`{"calendars":true,"reminders":true}` (each value reflects the actual grant).
Run it in the same OS identity and launch context that will run the gate. macOS
may attribute command-line access to the launching terminal or application;
rebuilding, moving, signing, or changing launch context can require a fresh grant.
Normal protocol requests never request permission: they return `permission_denied`
unless the relevant full-access grant already exists. Permissions can also be
reviewed in System Settings, Privacy & Security, Calendars and Reminders.

After configuring and authorizing the installed binary, start or restart the gate.
Open the owner Connectors page (`/connectors`, also usable on the phone), select
**Review and pin** on the
`apple-eventkit` Not pinned card, and sign with the owner's passkey. Its reviewed
manifest is committed under `packages/schemas/manifests/`; no credential needs to
be entered. The existing connector pin ceremony is documented in
[`infra/connectors.md`](../../infra/connectors.md).

If a read was attempted before permission was granted, the connector records
`auth_failed` and stays disabled. After granting access, an explicit owner check
through the gate's local control socket re-enables it and checks both grants:

```sh
curl --fail --silent --show-error --unix-socket "$EIDO_GATE_CONTROL_SOCKET" \
  --request POST http://localhost/connectors/apple-eventkit/connected
```

Run this as the gate user with the running gate's control socket path. The check
returns connector health, never calendar or reminder contents. A missing or
drifted signed manifest cannot be recovered this way; review and pin it first.

The automated tests use an in-memory fake store. They do not request TCC access,
read real calendars, or write real reminders. A successful native build proves
linkage, not a live permission grant or successful upstream operation. Live
verification runs on the intended Mac host against a dedicated synthetic calendar
and reminder list only, deleted afterwards; do not capture personal content in
issue comments or logs.

## One-request process protocol

Write one UTF-8 JSON object to stdin, then close stdin. The process writes one
JSON object and a newline to stdout and exits. There are no protocol logs or native
error details. Requests and responses are each limited to 1 MiB. Unknown fields,
unknown operations, invalid types, invalid dates, and missing required fields are
rejected. No operation accepts a token or approval signature; approval verification
belongs to the gate.

Every request is `{"operation":"<operation>","args":{...}}`:

| Operation             | Required arguments                                    | Optional arguments  |
| --------------------- | ----------------------------------------------------- | ------------------- |
| `list_calendars`      | none                                                  | none                |
| `list_reminder_lists` | none                                                  | none                |
| `list_events`         | `calendarId`, `start`, `end`                          | none                |
| `list_reminders`      | `listId`, `completedSince`                            | none                |
| `create_event`        | `calendarId`, `title`, `start`, `end`, `allDay`       | `location`, `notes` |
| `update_event`        | `id`, `calendarId`, `title`, `start`, `end`, `allDay` | `location`, `notes` |
| `create_reminder`     | `listId`, `title`                                     | `notes`, `due`      |
| `complete_reminder`   | `id`                                                  | none                |

Dates are full ISO 8601 timestamps with an explicit timezone; fractional seconds
are accepted. Responses emit UTC timestamps with milliseconds, except all-day event
bounds (below). Timed event intervals must have a strictly later end, and read
intervals may span at most 366 days.

All-day events (`allDay: true`) are dates in the host's timezone. Their `start`
and `end` are midnights written exactly as `YYYY-MM-DDT00:00:00` plus an offset;
only the date as written is used, and the offset is ignored. `start` is the first
day and `end` the day after the last day, so a one-day event on 15 January is
`"start":"2026-01-15T00:00:00Z","end":"2026-01-16T00:00:00Z"`, and it lands on
15 January whether the host is behind or ahead of UTC. Any other time, or an end
date not after the start date, is `invalid_request`; the gate refuses the same
intents before approval. Event reads return all-day bounds the same way: local
midnight with the host's offset, so the date as written is the local date and the
value can be sent back unchanged in an update.

A reminder `due` is an instant. The Helper stores it as the wall-clock date and
time that instant has in the host's timezone, so `2026-01-15T09:00:00-08:00` on a
Pacific host is due at 09:00 on 15 January.
Reminder reads return all incomplete items and completed items whose completion
timestamp is at or after `completedSince`. Items with unknown completion timestamps
are not represented as recently completed. `completedSince` may be at most 366 days
before the request (the same span as an event read window); an older cutoff is
refused with `invalid_request`, by the gate's `GET /apple/reminders` route before
the Helper starts and by the Helper itself. When a list's completed history in
that window exceeds the item or byte bound, read its incomplete reminders alone
by passing the request time (or later) as `completedSince`, then narrow the
window to read recent completions. Date-only Reminder due dates are
interpreted at midnight in their recorded timezone, or the host timezone when
EventKit supplies none, and returned as UTC.

Input IDs are nonempty and at most 1024 Unicode scalars; titles are nonempty and
at most 200, notes at most 20000, and locations at most 500. Empty location or
notes strings clear those fields. An update is a full replacement of its editable
fields: omitted location/notes clear them, while attendees, alarms, and other
unrepresented properties remain as stored. An update keeps the event in its
calendar: a different `calendarId` is refused with `unsupported_event`, since a
move can change accounts. Events with attendees cannot be updated, since saving
them may send attendees an update. Recurring and detached events cannot be
updated; this prevents unintended series changes. Reminder completion changes
only its completion state.

Success is `{"ok":true,"result":...}`. Results have these shapes:

- Calendar and reminder-list reads: `{"calendars":[{"id":"...","title":"...","writable":true}],"skipped":0}`.
- Event reads: `{"events":[{"id":"...","calendarId":"...","title":"...","start":"...","end":"...","allDay":false,"location":null,"notes":null,"modifiedAt":null,"hasAttendees":false,"recurring":false}],"skipped":0}`.
- Reminder reads: `{"reminders":[{"id":"...","listId":"...","title":"...","notes":null,"due":null,"completed":false,"completedAt":null,"modifiedAt":null}],"skipped":0}`.
- Writes: `{"id":"..."}`.

Event reads report whether `update_event` would refuse an event, so a caller
need not try it: `hasAttendees` is true when the event has attendees, and
`recurring` is true when it belongs to a series (it has recurrence rules or is a
detached occurrence; its id then carries the `recurrence:` prefix). Both are
always present on every event. The gate rejects an event reply that omits them,
so a Helper built before these fields must be rebuilt.

Nullable fields are always present. Upstream titles may be empty and are bounded
at 2000 Unicode scalars; output notes and locations at 20000; IDs at 1024. An
upstream item that fails these checks (an empty or over-long ID, an over-long
field, a NUL character, or an unparsable date) is left out of the read and counted
in `skipped`, so one malformed item does not fail the whole read and none is
dropped unreported. The gate's `GET /apple/*` replies always carry `skipped`, and
its audit row records the count. Lists have at most 2000 returned items. An
oversized result returns `unavailable`, never silently truncated data. Split event read windows or narrow the upstream calendar/list
when the result exceeds a bound. There is no pagination claim.

Failure is `{"ok":false,"code":"..."}`. Codes are `invalid_request`,
`permission_denied`, `not_found`, `read_only`, `unsupported_event`, and
`unavailable`. Errors never echo request values, paths, or OS error messages.

## Identity and authority limits

Calendar IDs are EventKit `calendarIdentifier` values. Ordinary event and reminder
IDs are local `calendarItemIdentifier` values. Recurring event instances are
readable with opaque IDs of the form
`recurrence:<calendarItemIdentifier>:<original-occurrence-start-in-UTC>`; these
are intentionally refused by `update_event`. These Apple identifiers are local
to the EventKit store and are **not Proton iCalendar UIDs**. Sync implementations
must retain the source and calendar with the ID. A full resync may be needed when
the underlying account is removed, migrated, or re-added.

Private pipes prevent a public helper write endpoint. They do not isolate the
helper from arbitrary code running as the same OS user: that code may start the
executable with the same EventKit grant. The gate owns write authorization at the
application boundary; enforcing a separate OS principal and restricting executable
access are host-isolation work in #70. This adapter does not assert those host
controls are installed. It does not itself implement ingestion, Today rows, or
source-aware proposal routing; those belong to #79 and #746.

## Session bridge mode

The gate runs as its own OS user (`_eidogate`), outside the owner's login session,
so it cannot reach EventKit grants, Things automation, or the owner's file roots
directly. The session bridge is an agent mode of this executable that runs as the
owner, started by a LaunchAgent (#827), and does those operations for the gate
over a Unix socket (decision in #781). It holds no tokens and makes no approval,
policy, or audit decision: the gate has already verified the signed approval and
written the audit row before it calls, and it parses every response again.

```sh
eido-helper --bridge \
  --socket <absolute path> \
  --peer-user <gate user name> \
  --things-scripts <absolute directory> \
  --file-helper <absolute path> \
  --file-helper-sha256 <lowercase hex> \
  [--file-roots <absolute path>] \
  [--file-helper-copy-dir <absolute directory>]
```

Each flag is given once, in any order. All but `--file-roots` and
`--file-helper-copy-dir` are required;
anything else writes `invalid_request` to stdout and exits 1. At start the
bridge, in this order:

1. resolves `--peer-user` to a uid once (a later rename does not change it);
2. reads every Things script in the table below from `--things-scripts`, checks
   each file's SHA-256 against the hash built into the bridge, and keeps the
   checked bytes in memory;
3. reads `--file-helper` once and checks its SHA-256 against
   `--file-helper-sha256`, then runs from a private copy of those bytes (see
   [The file helper's private copy](#the-file-helpers-private-copy));
4. reads the owner's approved file roots from `--file-roots` (see
   [Approved file roots](#approved-file-roots)). Without the flag no root is
   approved and every `file` op is refused; the bridge then writes the notice
   `file_roots_absent` to stderr, or `file_roots_empty` for a list with no
   roots, and goes on starting;
5. binds the socket with mode `0600`. A stale socket at the path is replaced; a
   socket that still accepts connections (another bridge) or any other kind of
   file there is refused.

Any failure stops the start before the socket exists: the bridge writes one code
to stderr (`peer_user_unknown`, `things_scripts_mismatch`, `file_helper_mismatch`,
`file_helper_copy_unsafe`, `file_helper_copy_failed`, `file_roots_unsafe`,
`file_roots_invalid`, or `socket_failed`) and exits 1, leaving no socket and no
private copy behind. It never serves with a partial table. It does not
watch its parent (launchd). SIGTERM or SIGINT stops accepting and removes the
socket (unless another bridge has since replaced it), lets accepted requests
finish for up to 15 seconds (inside launchd's 20-second exit timeout), deletes
its private copy of the file helper, and exits 0. Request mode is unchanged and still exits when the gate exits.

The socket's `0600` mode admits only the owner at the file system; the ACL that
`host plane` sets on the socket's directory (#827) grants the gate user access. The bridge creates a new socket file on
every start, so that access must come from the directory (an inherited ACL), not
from an ACL set once on the socket. That is not the check that
matters: each accepted connection's peer uid is read from the kernel with
`getpeereid` before any byte is read, and a connection from any uid other than the
`--peer-user` uid is closed with no response. `getpeereid` reports the effective
uid the peer had when it connected; the bridge does not check the peer's pid,
audit token, or code signature, since uid is the boundary #781 sets (any process
running as the gate user is the gate). At most eight connections are served at
once; a ninth is closed unread, with no response.

The gate finds the bridge through two environment variables that are set
together, `EIDO_SESSION_BRIDGE_SOCKET` (the absolute socket path) and
`EIDO_SESSION_BRIDGE_UID` (the owner's numeric uid, the user the bridge runs as).
Node cannot read a socket peer's credentials, so the gate authenticates the bridge
by the directory chain: an existing socket must be owned by that uid and have no
group or world write bit, and every directory above it must be owned by that uid
or root and not be group- or world-writable (a root-owned sticky directory is the
one exception). The gate refuses to start, and refuses to connect, when any of
that fails. So the ACL that grants the gate user access must not add write access
for any other principal on the socket's directory. `host plane` sets both
variables for the gate daemon and puts the inherited ACL on the directory (see
`infra/plane-split.md`, "Session bridge").

### Framing

One request and one response per connection. A frame is a 4-byte big-endian
unsigned length followed by that many bytes of UTF-8 JSON. Requests are at most
8 MiB, and responses at most 24 MiB (an over-long response is replaced by
`unavailable`). A header naming a longer request gets `frame_too_large` without
the body being read; a zero length gets `invalid_request`. The whole request
(header and body) must arrive within 10 seconds of the peer check, or the
connection is closed with no response; the response write has its own 10-second
limit. The bridge closes the connection after its response. Peer input is parsed, never interpolated: no request field becomes a
script, a path to run, a shell word, or an environment variable.

### Operations

Every request is an object whose `op` selects one of three entries. Unknown keys
are refused with `invalid_request`, and an unknown `op` with `unknown_op`.

| `op`       | Fields                                        | What runs                                    |
| ---------- | --------------------------------------------- | -------------------------------------------- |
| `eventkit` | `request`: a request-mode object              | the request-mode service, in process         |
| `things`   | `script`, `sha256`, `argv` (array of strings) | a pinned Things script through `osascript -` |
| `file`     | `request`: a file-helper request              | the pinned file helper                       |

**`eventkit`.** The response is exactly the request-mode response
(`{"ok":true,"result":...}` or `{"ok":false,"code":"..."}`) for the same
`{"operation":...,"args":...}` object, with the same validation, bounds, and
codes as the [one-request protocol](#one-request-process-protocol). The EventKit
store is opened on the first `eventkit` request, so a bridge that never serves one
never opens EventKit.

**`things`.** `script` must name an entry in the table and `sha256` must equal its
built-in hash, or the request is `unknown_script`. `argv` must have exactly the
listed number of strings, each at most 65536 Unicode scalars with no NUL, or the
request is `invalid_request`. The bridge pipes the script bytes it checked at
start to `/usr/bin/osascript -` on stdin, with `argv` after the `-` (so an
argument that looks like an `osascript` flag is only an argument to the script's
`on run argv`), environment `PATH=/usr/bin:/bin`, a 10-second limit, and a 5 MiB
stdout limit, as the gate's own Things runner uses. Exit 0 returns
`{"ok":true,"result":{"stdoutBase64":"..."}}`. An Automation refusal (`-1743`)
returns `automation_denied`; any other failure, timeout, or overflow returns
`unavailable`. Stderr is never returned.

The table is the scripts in `packages/gate/src/internal/things/scripts/` with the
argument counts the gate passes them. A changed script needs a new hash in
`Sources/EidoHelperKit/Bridge.swift` and a new bridge build; a test fails when
the table and the directory differ.

| Script          | Arguments | SHA-256                                                            |
| --------------- | --------- | ------------------------------------------------------------------ |
| `add-project`   | 6         | `cca3c1d0e748cf09e7ab652729896e7536a013306efad49f3db2d4dcb90104df` |
| `add-todo`      | 5         | `9338821e3c180a49ec73757ba471cc6db347ee2acc9bdae23767cbe2c4e9143c` |
| `cancel-todo`   | 1         | `43aee049e865ca8281dfbbe4dd9632f580aac13a507eda3619090a3fbb65225a` |
| `complete-todo` | 1         | `7add17bfaf9345775b29c8d96bf0a466461c3739eb35bb17ad1ffd6953c95363` |
| `get-project`   | 1         | `6bfc1420ec7ce50cf67f60ddf439eb3b36523647360952b26e38a9976958fc00` |
| `get-todo`      | 1         | `26a7d607992e9d6a3ee854120210dcbebdb25e1dd119a04cee34e00687b6746e` |
| `list-areas`    | 0         | `9a55833b22dc537d9472b9f97e625d0c24f898e88bb9ce275bc47dbc193ef390` |
| `list-deadline` | 1         | `05e2d9711cc7e01060f5a90d8a6b4a88cbd2976e4d9ca9d60dfd42ff487a1d1c` |
| `list-projects` | 1         | `c23bc2cb30d1bcffbbbbe64313cb70a6fb2fb8b0adc4505695725986a11dfd75` |
| `list-tags`     | 0         | `2a7a7f473f2cbfd0abcdfecd11b192a43bc438b2bc4d68ecfea2d371ceb5bcbe` |
| `list-todos`    | 1         | `bb4515744a8f4cc4cc4494afb158e79a8a493c0085509605fdbafc044185af84` |
| `schedule-todo` | 2         | `bb189c2fdac33c531e8e49005964bc04248bfa9c06b3e129c16c0500c256daf6` |
| `update-todo`   | 9         | `016679f8cbdbdcc49e790bbf88819f2690815ca2c1d748e2f567ac6715d1374f` |

**`file`.** `request` is one request to the file helper (ADR 0006), checked
against the bridge's copy of `gate-file-helper-request` in `packages/schemas`:

| File op    | Fields                          |
| ---------- | ------------------------------- |
| `identify` | `path`                          |
| `list`     | `root`, `path` (may be empty)   |
| `read`     | `root`, `path`, `maxBytes`      |
| `create`   | `root`, `path`, `contentBase64` |
| `move`     | `root`, `from`, `to`            |
| `trash`    | `root`, `path`, `trashName`     |
| `restore`  | `root`, `trashName`, `path`     |

`root` is exactly `{path, dev, ino, trashDir}`: `dev` and `ino` are 1 to 40
lowercase hex digits, and `trashDir` is 1 to 64 of `A-Z a-z 0-9 . _ -`, not ending
in `.`. Paths are 1 to 4096 Unicode scalars, `trashName` 1 to 255,
`contentBase64` at most 4,000,000, all without NUL; `maxBytes` is an integer from
1 to 8388608. An op outside the table is `unknown_op`; a missing, extra, or
invalid field is `invalid_request`. The bridge rebuilds the request from these
fields alone, serializes it with sorted keys, and writes it to the helper's stdin.
The bridge runs only its private copy of the helper (never `--file-helper`
itself), with no arguments and an empty environment, after checking that the
copy is still the file it made at start and still has the pinned SHA-256 (a
changed copy is `unavailable` and never runs),
with a 30-second limit and the gate's stdout limits (12 MiB for `read`, 512 KiB
for `list`, 64 KiB otherwise). Exit 0 returns
`{"ok":true,"result":{"stdoutBase64":"..."}}` with the helper's own JSON response
inside; anything else is `unavailable`. The helper confines every path to the
root, as it does for the gate today.

The request may also carry `"sha256"`, the file helper's SHA-256 the caller
pinned: `{"op":"file","request":{...},"sha256":"<64 lowercase hex>"}`. A value
other than the bridge's own `--file-helper-sha256` is `unavailable`, refused
before the roots check and without starting anything; a value that is not 64
lowercase hex digits is `invalid_request`. Without the field the bridge runs its
own pinned helper, as before.

Before any of that, the request's `root` must be one the owner approved: its
`path`, `dev` and `ino` must equal one entry in the approved list, and the
directory at that path, opened now from `/` one component at a time without
following symbolic links, must have that device, inode and canonical path.
`identify` is admitted only for a `path` that is exactly an approved root, and
only while that directory still has the listed identity. Anything else is
`root_not_approved`, and the file helper is not started (#865).

### Approved file roots

The owner decides which directories the gate may reach through the bridge
(decision in #865). The list is a JSON file the bridge reads once, at start,
from `--file-roots`:

```json
{
  "roots": [
    {
      "path": "/Users/example/Documents/Notes",
      "dev": "16777232",
      "ino": "1234567"
    }
  ]
}
```

- `path` is absolute and canonical: no symbolic link anywhere in it, no empty,
  `.` or `..` component, no trailing `/`, under 1024 bytes. A path is listed at
  most once. Get it with `realpath <dir>` (for example `/tmp` is
  `/private/tmp`), and keep the case and Unicode normalization the directory has
  on disk: paths are compared byte for byte, so `café` written with a combining
  accent is not the same root as `café` with a precomposed one.
- `dev` and `ino` are the directory's device and inode in decimal, with no
  leading zeros, as `stat -f '%d %i' <path>` prints them and as the file helper's
  `identify` returns them on macOS. A root that is removed and created again has
  a new inode, so it must be approved again.
- Keys other than `roots`, `path`, `dev` and `ino` are refused. A key repeated
  in one object keeps its first value. `{"roots":[]}` approves nothing.

`--file-roots` must be an absolute path to the file. The bridge resolves the
file's parent directory with `realpath`, then opens `/` and each directory of
that resolved path one at a time without following symbolic links, and opens
the file itself the same way. Each directory must be owned by root or by the
user the bridge runs as, have no group or other write bit unless it is sticky
(as `/tmp` is), and have no access control list entry that allows a write. The
file must be a regular file with one hard link, owned by the user the bridge
runs as, with no group or other write bit (`chmod 600` is the intent) and no
access control list entry that allows a write; deny-only entries are accepted.
Its type, links, ownership, mode and ACL are read from the same open descriptor
the list is read from. A list that fails those checks stops the start with
`file_roots_unsafe`; a relative path, a missing, unreadable, malformed, or
over-1-MiB list stops it with `file_roots_invalid`. A change to the list takes
effect when the bridge is restarted. The LaunchAgent in #827 will pass the flag.

To approve a new root:

1. add its entry to the list;
2. restart the bridge;
3. approve the folder in the web UI. The gate identifies the folder through the
   bridge, and the bridge identifies only a listed root, so until steps 1 and 2
   are done the gate answers `root_not_approved` (422) and stores nothing.

What the check closes, and what it does not:

- A root swapped after the bridge's check is still refused: the file helper
  opens the root again without following links and compares its device and inode
  with the request's, which the bridge has already required to equal the owner's
  entry. The bridge does not hand its open descriptor to the helper.
- The approval is by path, device and inode. If an approved directory is deleted
  and the file system later reuses its inode number for a new directory at the
  same path, the new directory is admitted.
- The identity is the device and inode, not the volume. Removable and
  remountable volumes are not told apart: another volume mounted at the same path
  whose directory has the same device and inode numbers is admitted. No volume
  UUID is checked (decision in #897).
- Another user cannot replace or edit the list: every directory to it and the
  file itself are checked for ownership, write bits, ACLs and extra hard links.
  A process running as the owner can still change the list; it already has the
  owner's files.

### The file helper's private copy

The bridge never runs the binary at `--file-helper`. At start it opens that path
once, without following a symbolic link at its last component, requires a
regular file of at most 256 MiB, reads it and checks the bytes against
`--file-helper-sha256` (`file_helper_mismatch` otherwise). It then:

1. opens the copy directory (`--file-helper-copy-dir`, or the user's cache
   directory from `confstr(_CS_DARWIN_USER_CACHE_DIR)` when the flag is absent)
   without following a symbolic link;
2. removes private directories (`eido-file-helper.*`) a bridge that did not stop
   cleanly left there. A directory another running bridge still holds (an
   exclusive `flock`) is kept;
3. creates a new directory `eido-file-helper.<random>` with mode `0700` and
   holds its lock for the life of the bridge;
4. creates `file-helper` in it exclusively (`O_CREAT | O_EXCL`, no symbolic link
   followed), writes the bytes it hashed in memory, and sets mode `0500`;
5. reads the copy back through a new descriptor and checks it against the pin
   again (`file_helper_copy_failed` otherwise).

Before every `file` op the copy is opened again and must be the same file
(device and inode), with one link, owner and mode `0500`, and the pinned
SHA-256; otherwise the op is `unavailable` and nothing runs.

**Location requirements.** The original `--file-helper` needs only to be a
regular file the bridge's user can read, not a symbolic link at its last
component; replacing it after start changes nothing until the next start. The
copy directory must be a directory (not a symbolic link) owned by the bridge's
user with no group or other write bit, and every directory above it must be owned
by root or that user and be writable by no one else unless it is sticky (as
`/private/tmp` is). It must be on a local volume that honours ownership and
allows exec: not a network volume, not `noexec`, and not an external disk with
"Ignore ownership on this volume" set (the default for external disks), where
every local user counts as the owner. Otherwise the start fails with `file_helper_copy_unsafe`; a
missing copy directory is `file_helper_copy_failed`. The default cache directory
under `/var/folders` meets this.

**What this closes.** A binary replaced or changed at `--file-helper` after start
is never run. There is no gap between the check and the copy: the bytes hashed are
the bytes written. No other user can create, replace, or rename the copy or its
directory.

**What remains.** A process running as the bridge's own user (or root) can still
change the copy between the check before a run and the `exec`, since macOS has no
`fexecve`; such a process can already act as the owner. ACLs on the copy
directory are not checked, only owner and mode bits. The gate's own file helper
runner (`packages/gate`) still hashes and then runs by path; that is #903. The gate does not yet send its pin on file requests
(#904).

### Errors

Failure is `{"ok":false,"code":"..."}` and never echoes request values, paths, or
OS messages. Bridge codes are `invalid_request`, `unknown_op`, `unknown_script`,
`frame_too_large`, `automation_denied`, `root_not_approved`, and `unavailable`; `eventkit` responses
also carry the request-mode codes. A refused request ends only its own connection.

### What the tests do not prove

The tests use socket pairs and sockets under `/tmp` in the test user's own
account, a fake EventKit store, and a recording double in place of `osascript` and
the file helper, except one test that starts the bridge with the real process
runner and a synthetic shell-script helper to show a replaced original never
runs. Approved roots and copy directories are synthetic temporary directories. They do not
show the uid the bridge sees when `_eidogate`
connects through the #827 ACL, which app macOS credits with the Automation and
EventKit grants when launchd starts the bridge, or how the bridge behaves while
the screen is locked or another user is switched in. Those are checked on the
host when #827 installs the LaunchAgent.
