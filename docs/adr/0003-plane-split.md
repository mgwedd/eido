# 0003: The gate and the data plane run as two processes with two databases

Status: accepted

## Context

ADR 0001 made the gate a package. Until #42 the gate and the data-plane workers ran as modules of one Node process, so the boundary was only the import graph: a bug or a compromised dependency in core ran with the same memory, files and environment as the token store. Attachment parsing (#43) must not start before that changes.

## Decision

Two processes, two SQLite files, one narrow API between them.

- **Gate** (`packages/gate/src/main.ts`, `pnpm --filter @eido/gate start`). It owns `eido-control.db` (intents, approvals, executions, audit_log, connectors) in `EIDO_GATE_DATA_DIR` and opens no other database. It logs to `gate.log` in the same directory.
- **Data plane** (`packages/core/src/main.ts`, `pnpm --filter @eido/core start`). It owns `eido-data.db` (documents, extractions, links, obligations, entities, cursors, context_packs) in `EIDO_DATA_DIR` and logs to `data-plane.log` there.
  - Its environment is built from an allowlist: `EIDO_DATA_DIR`, `EIDO_GATE_SOCKET`, `EIDO_LLAMA_HOST`, `EIDO_LLAMA_PORT`, `EIDO_GMAIL_PROXY_URL`, `EIDO_CONVERSATION_DIGEST_IDLE_TTL_MINUTES`, `EIDO_DIGEST_SECTION_TOKENS`, `EIDO_REPLIES_CONFIG`, and where core's API listens (#153): `EIDO_CORE_HOST`, `EIDO_CORE_PORT`, `EIDO_CORE_BASE_PATH`, `EIDO_CORE_ALLOWED_HOSTS`. None of these carries a credential or a gate path. Started with anything else, it re-runs itself with only those (the OS's own text-encoding variable on macOS aside), so no token, Keychain or OAuth variable and no gate path can be inherited.
  - It serves core's API (#86) on loopback TCP only: started with `EIDO_CORE_HOST` set to anything but `127.0.0.1` or `::1`, it exits before opening `eido-data.db`. Core has no auth; the tailnet is the trust boundary and `tailscale serve` (#178) is the only way in.
  - Core exposes `GET /connectors/health` as a read-only projection from the gate for the Today page. It contains connector names, health, failure counts and bounded error/retry details; it never contains credentials, manifests or mail payloads.
  - Its configuration has no path to `eido-control.db` or to the control socket. A test fails if the core source names the control DB, `openControlDb` or the gate's control variables (the test harness, which starts the gate, is the one exception).
- **Transport.** HTTP over a local socket the gate listens on: a Unix domain socket on macOS and Linux, a named pipe on Windows. The gate listens on no TCP port.
- **Two listeners in the gate**, so the write surface is separated physically:
  - Data-plane listener, at `EIDO_GATE_SOCKET` (mode 0660). Routes only:
    - `POST /intents` proposes an intent. The gate validates, canonicalizes, hashes and tiers it itself.
    - `GET /intents?state=pending` lists pending intents.
    - `GET /intents/:id` returns `{ id, kind, tier, state, edited_from }`.
    - `GET /intents/:id/history` returns the state transitions.
    - `POST /audit` appends one hash-only `audit.profile.*` row for a profile change in core (#181), or `audit.ledger.*` row for a local obligation state change (#104). See "How the data plane uses the client".
    - `GET /connector-health` returns only each connector's health, consecutive failure count, bounded error code and next attempt time. Health changes are written only by the gate after observing an upstream read; core cannot set health or clear an open breaker.
    - When Proton Bridge is configured (#195): `GET /mail/proton/folders`, `GET /mail/proton/folders/:folder/state` and `GET /mail/proton/folders/:folder/messages?fromUid=&limit=`. See "Proton mail reads".
    - An open connector admits one read probe after its persisted backoff. The gate reserves it atomically and closes the breaker only after that read succeeds; failed probes reopen with a longer backoff. Writes stay refused while the connector is open.
    - Every other method or path returns 404.
    - Request bodies are capped at 1 MiB (413 above it). Malformed JSON gets 400 with no echo of the body. A schema-invalid intent gets 422 with field paths only. A forbidden intent is stored as rejected and answered with 403.
    - No response carries a payload body, a signature or a nonce.
    - The gate writes an audit row for every proposal it accepts or refuses, including the refusals before parsing (`intent.request_refused.*`).
  - Control listener, at `EIDO_GATE_CONTROL_SOCKET` (mode 0600). It serves the same reads plus `GET /audit/chain`. Its path is never in the data plane's configuration.
- **Room for more listeners.** Each listener is a handler mounted on the same server wrapper (`createGateServer` in `packages/gate/src/internal/http.ts`), with its own socket or port. The phone listener (#85: loopback TCP behind `tailscale serve`, session-checked, with approve and reject) and the Mac-local admin listener (#78) are added as further handlers, without changing the data-plane listener or this split. The web transport is ADR 0004 (#178).
- **Client.** `createIntentClient({ socketPath })` from `@eido/gate` (`packages/gate/src/index.ts`, the only public entry) is the data plane's way into the gate for intents. It offers `propose`, `status`, `history`, `listPending` and the read-only `getConnectorHealth`. Its sibling `createAuditClient({ socketPath })` offers `record`, for `POST /audit`. The third, `createProtonMailClient({ socketPath })` (#195), offers `listFolders`, `folderState` and `fetchRaw` over the mail read routes. These clients are the data plane's only ways into the gate.
  - Every response is parsed with its schema from `@eido/schemas`.
  - If the gate cannot be reached, a call rejects within 2 s with `GateUnavailableError`. Nothing is queued and nothing silently succeeds.
  - A refusal rejects with `GateRequestError`: status, code, and the field errors for a 422.
- **Direction.** The gate calls nothing in the data plane: dependency-cruiser's `gate-imports-schemas-only` rule forbids any workspace import from `packages/gate` except `@eido/schemas`, and the boundary fixture proves the rule fires. `gate-internals-are-private` still keeps everyone else on the public entry point.
- **The stdlib `http` exception.** ADR 0001 says the gate uses `fetch` and no other network library. `fetch` cannot target a socket path without a new dependency, so both sides use Node's `node:http` with `socketPath`. This is the one exception; it adds no dependency, and `packages/gate/ALLOWED_DEPENDENCIES` is unchanged.
- **Test harness.** `spawnPlanes({ tmpDir })` (`packages/core/src/planes/spawn-planes.ts`) starts both processes against temp databases and sockets and tears them down; #43 and #56 reuse it.

## How the data plane uses the client (#141, #153)

- Propose inside the core transaction that records the work. A call resolves to `{ id, tier, state, reason? }`.
- Commit only when the call resolves and `state` is not `rejected`. Roll back when:
  - it rejects with `GateUnavailableError` (the gate is down), or
  - it rejects with `GateRequestError` (the gate refused the request), or
  - it resolves with `state: "rejected"` (policy refused the intent; `reason` says why).
- Core's profile audit sink (#141, #153) calls `createAuditClient(...).record` inside the same transaction, not `propose`. There is no audit intent kind and no exemption to the auto-tier policy (#181).
  - `POST /audit` takes a `GateAuditRecordRequest` from `@eido/schemas`: the action (`entity.create`, `entity.update`, `entity.delete`, `account.assign`, `account.unassign`, or the obligation state changes `obligation.done`, `obligation.resolve` and `obligation.reopen` from #104) and the subject, before and after hashes. Nothing else is accepted, so no record goes to the gate in clear.
  - The gate validates the body with the schema, then checks that every hash is lowercase hex and that the before and after hashes are null or set as the action requires. A refusal is 400 (413 over 1 MiB) and is audited as `audit.request_refused.*`.
  - The gate appends the row itself: actor `data-plane`, action `audit.profile.<action>` (`audit.ledger.<action>` for `obligation.*`), target the subject hash, and the detail hash of the whole entry. It answers 201 with the row's `seq`. The data plane still never writes `audit_log`.
  - Commit when the call resolves; roll back when it rejects with `GateUnavailableError` or `GateRequestError` (including the client's 2 s timeout).
  - The audit call runs before `COMMIT`, so the gate's row can outlive the change it records: a timeout that fires after the gate appended the row, or a `COMMIT` that fails after the call resolved, rolls the change back but leaves its audit row. The log can hold an entry for a change that never committed; it never misses one for a change that did.
  - `node:sqlite` has one connection and the call is awaited inside the transaction, so the profile store runs its calls one at a time: no read sees, and no other write joins, a transaction whose audit call is in flight. The 2 s timeout bounds how long one call holds the queue. The store admits at most 32 calls, including the active one; excess calls fail immediately with `busy` (HTTP 503), and the caller may retry after capacity frees.
  - Profile audit hashes currently remain unkeyed SHA-256 of JSON-serialized values. Core must compute them before calling the gate because `POST /audit` accepts hashes only, while the gate alone may hold credentials and cryptographic secrets. A key in core would break that boundary; sending clear profile values to the gate would broaden its data access. A reader of the gate audit log can test guesses for low-entropy subjects such as an email address and recover them by dictionary attack. The hashes hide clear values from casual inspection, not from such an attacker. They support correlation and digest comparison; audit-chain integrity is a separate property. Neither provides confidentiality for guessable values. The decision for new rows is below (#193).

## Profile audit subject privacy decision (#193)

The threat addressed is an attacker who obtains a read-only copy of `eido-control.db` or its `audit_log`, but cannot read the gate's secret vault, observe the gate socket, or send requests to it. This includes an exposed backup containing only the control database. A compromised gate can read the key and test guesses; a compromised data plane already sees clear profile data. A local attacker who can read both the log and the data-plane socket can also test guesses through the audit endpoint, so this change does not substitute for the OS isolation in #70. Repeated subjects within one installation remain linkable, and action names and row timing remain visible.

For **new** `audit.profile.*` rows, select gate-side HMAC-SHA-256 pseudonyms (#204). Core continues to send its existing SHA-256 digests, not clear values or a key. The gate uses a random 256-bit per-installation key kept in its vault outside `eido-control.db`; it derives separate, domain-separated tags for the subject, before and after digests and stores only those tags. The audit detail hash is computed from the action and tagged values, never from the incoming unkeyed digests. The API still returns only the sequence number. The gate must fail the audit request if the key is unavailable, so core rolls its transaction back rather than silently storing an unprotected row. This uses the keyed construction in [RFC 2104](https://www.rfc-editor.org/rfc/rfc2104.html). The gate receives an unkeyed digest and can test candidate clear values itself; the decision protects the audit-log-only reader, not the gate or a socket observer.

The log is append-only, so historical unkeyed rows cannot be rewritten or made confidential retroactively. New rows need an explicit scheme and key-epoch marker so readers do not mistake legacy hashes for pseudonyms; a lost key must not be silently regenerated under the same marker. Rotation starts a new epoch and leaves old rows intact. The implementation and tests for storage, versioning, failure and rotation are #204; until it ships, all profile audit rows retain the current dictionary-attack exposure.

An [RFC 9497](https://www.rfc-editor.org/rfc/rfc9497.html) OPRF or VOPRF could blind core's input from the gate socket, but that is outside this log-only threat. It would require a new evaluation endpoint and cryptographic implementation, and a caller with access to that endpoint could test guesses online. The RFC itself discusses risks from evaluation-oracle access and rate limiting (Section 7.2.3). Gate-side HMAC keeps the existing one-call audit path and avoids creating a separate evaluation oracle; it still needs socket access control because an attacker able to submit chosen audit entries and read the resulting log can test guesses.

## Proton mail reads (#195)

- The gate reads Proton Bridge over IMAP for core and returns raw RFC 5322 messages, base64-encoded; core parses them. The gate never parses bodies.
- `fromUid` is required (1 to 2^32-1). `limit` defaults to 50 and is capped at 100. A page holds at most 32 MiB; a message over 25 MiB is not returned and its UID is listed in `skipped`. Folder listings return at most 1000 folders.
- An unknown folder is 404. A bad query or folder encoding is 400. Bridge unreachable is 502 `handshake_failed`; a refused password is 502 `auth_failed`, and the gate does not log in again with that password until the vault holds a new one. Any other Bridge failure is 500 with no Bridge text.
- Each call writes one audit row (actor `data-plane`, target `proton-mail`) whose detail hash covers counts only: folders, messages, skipped and bytes. Folder names, subjects and bodies are never in the audit log.
- The client's fetch call allows 60 s; the other calls keep the 2 s timeout.
- Writes do not use these routes. Approved mail intents run through the executor's Bridge writers (`packages/gate/src/internal/bridge/writers.ts`), which accept only the pinned `proton-mail` connector with password auth and no HTTP egress.

## Proton Bridge TLS pin (#218)

The gate authenticates Bridge on loopback before sending its vault-held Bridge password. Production configuration accepts only STARTTLS or implicit TLS. `EIDO_BRIDGE_ALLOW_SELF_SIGNED` and `EIDO_BRIDGE_TLS=none` are refused; direct clear-text settings remain in the fake-Bridge test harness only. IMAP and SMTP trust the exported Bridge certificate as a local CA and require an exact SHA-256 fingerprint match on the peer certificate. A different certificate fails the handshake before LOGIN or AUTH. The same pin applies to both ports; rotation needs an explicit new export, fingerprint and gate restart.

On first setup (#68), use Bridge's **Export TLS certificates** setting to obtain its certificate. Keep only the public certificate in a gate-owned file; never place Bridge's exported private key in Eido's data directory. Compute the SHA-256 digest of the certificate's DER bytes out of band (`openssl x509 -in bridge-cert.pem -outform DER | shasum -a 256` on the Mac), then set `EIDO_BRIDGE_CERT_PATH` to the public PEM file and `EIDO_BRIDGE_CERT_SHA256` to its 64-character lowercase hex digest in the gate's launch configuration. Do not learn the pin by connecting to an unverified loopback port: another local process could be listening there while Bridge is down. The gate checks the file against the configured digest at startup and uses that exact certificate for each TLS connection. Proton documents the export setting at https://proton.me/support/comprehensive-guide-to-bridge-settings.

## What is not decided here

- OS-level isolation: two macOS users, file ownership, sandbox profiles, pf rules (#70), and the live-host isolation test (#56). Until then the two processes may run as the same user, and the split is enforced by configuration, the environment allowlist and the tests.
- Whether the llama-server loopback port is a third allowed destination for the data-plane user (open question on #42).

## Consequences

- A crash or compromise in the data plane no longer shares memory, environment or database handles with the gate.
- Every gate call from core is an HTTP request over a local socket and can fail; callers must handle `GateUnavailableError`.
- The gate is a long-running service that must start first; the data plane fails its calls, and does not queue them, while the gate is down.
- Both packages run their TypeScript directly with Node's type stripping and a small resolve hook (`src/ts-hooks.ts`), so gate and core sources avoid syntax that needs transpiling (such as parameter properties).
