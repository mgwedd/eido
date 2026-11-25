# Eido Helper

The macOS 14+ native adapter for Apple Calendar and Reminders, tracked by #749
(part of #79). It uses EventKit and contains no network client, socket listener,
credentials, delete operation, or package dependencies. The gate starts a fresh
process for each operation, with private anonymous stdin/stdout pipes, and checks
the response against the shared schemas. Read operations reach it through the
gate's read client; writes run only after the gate verifies signed approval.

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
are accepted. Responses emit UTC timestamps with milliseconds. Event intervals
must have a strictly later end, and read intervals may span at most 366 days.
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
- Event reads: `{"events":[{"id":"...","calendarId":"...","title":"...","start":"...","end":"...","allDay":false,"location":null,"notes":null,"modifiedAt":null}],"skipped":0}`.
- Reminder reads: `{"reminders":[{"id":"...","listId":"...","title":"...","notes":null,"due":null,"completed":false,"completedAt":null,"modifiedAt":null}],"skipped":0}`.
- Writes: `{"id":"..."}`.

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
