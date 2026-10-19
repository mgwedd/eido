# 0003: The gate and the data plane run as two processes with two databases

Status: accepted

## Context

ADR 0001 made the gate a package. Until #42 the gate and the data-plane workers ran as modules of one Node process, so the boundary was only the import graph: a bug or a compromised dependency in core ran with the same memory, files and environment as the token store. Attachment parsing (#43) must not start before that changes.

## Decision

Two processes, two SQLite files, one narrow API between them.

- **Gate** (`packages/gate/src/main.ts`, `pnpm --filter @eido/gate start`). It owns `eido-control.db` (intents, approvals, executions, audit_log, connectors) in `EIDO_GATE_DATA_DIR` and opens no other database. It logs to `gate.log` in the same directory.
- **Data plane** (`packages/core/src/main.ts`, `pnpm --filter @eido/core start`). It owns `eido-data.db` (documents, extractions, links, obligations, entities, cursors, context_packs) in `EIDO_DATA_DIR` and logs to `data-plane.log` there.
  - Its environment is built from an allowlist: `EIDO_DATA_DIR`, `EIDO_GATE_SOCKET`, `EIDO_LLAMA_HOST`, `EIDO_LLAMA_PORT`. Started with anything else, it re-runs itself with only those (the OS's own text-encoding variable on macOS aside), so no token, Keychain or OAuth variable and no gate path can be inherited.
  - Its configuration has no path to `eido-control.db` or to the control socket. A test fails if the core source names the control DB, `openControlDb` or the gate's control variables (the test harness, which starts the gate, is the one exception).
- **Transport.** HTTP over a local socket the gate listens on: a Unix domain socket on macOS and Linux, a named pipe on Windows. The gate listens on no TCP port.
- **Two listeners in the gate**, so the write surface is separated physically:
  - Data-plane listener, at `EIDO_GATE_SOCKET` (mode 0660). Routes only:
    - `POST /intents` proposes an intent. The gate validates, canonicalizes, hashes and tiers it itself.
    - `GET /intents?state=pending` lists pending intents.
    - `GET /intents/:id` returns `{ id, kind, tier, state, edited_from }`.
    - `GET /intents/:id/history` returns the state transitions.
    - `POST /audit` appends one hash-only `audit.profile.*` row for a profile change in core (#181). See "How the data plane uses the client".
    - Every other method or path returns 404.
    - Request bodies are capped at 1 MiB (413 above it). Malformed JSON gets 400 with no echo of the body. A schema-invalid intent gets 422 with field paths only. A forbidden intent is stored as rejected and answered with 403.
    - No response carries a payload body, a signature or a nonce.
    - The gate writes an audit row for every proposal it accepts or refuses, including the refusals before parsing (`intent.request_refused.*`).
  - Control listener, at `EIDO_GATE_CONTROL_SOCKET` (mode 0600). It serves the same reads plus `GET /audit/chain`. Its path is never in the data plane's configuration.
- **Room for more listeners.** Each listener is a handler mounted on the same server wrapper (`createGateServer` in `packages/gate/src/internal/http.ts`), with its own socket or port. The phone listener (#85: loopback TCP behind `tailscale serve`, session-checked, with approve and reject) and the Mac-local admin listener (#78) are added as further handlers, without changing the data-plane listener or this split. The web transport is ADR 0004 (#178).
- **Client.** `createIntentClient({ socketPath })` from `@eido/gate` (`packages/gate/src/index.ts`, the only public entry) is the data plane's only way into the gate. It offers `propose`, `status`, `history`, `listPending` and `recordAudit`.
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
- Core's profile audit sink (#141, #153) calls `recordAudit` inside the same transaction, not `propose`. There is no audit intent kind and no exemption to the auto-tier policy (#181).
  - `POST /audit` takes a `GateAuditRecordRequest` from `@eido/schemas`: the action (`entity.create`, `entity.update`, `entity.delete`, `account.assign` or `account.unassign`) and the subject, before and after hashes. Nothing else is accepted, so no record goes to the gate in clear.
  - The gate validates the body with the schema, then checks that every hash is lowercase hex and that the before and after hashes are null or set as the action requires. A refusal is 400 (413 over 1 MiB) and is audited as `audit.request_refused.*`.
  - The gate appends the row itself: actor `data-plane`, action `audit.profile.<action>`, target the subject hash, and the detail hash of the whole entry. It answers 201 with the row's `seq`. The data plane still never writes `audit_log`.
  - Commit when the call resolves; roll back when it rejects with `GateUnavailableError` or `GateRequestError`.

## What is not decided here

- OS-level isolation: two macOS users, file ownership, sandbox profiles, pf rules (#70), and the live-host isolation test (#56). Until then the two processes may run as the same user, and the split is enforced by configuration, the environment allowlist and the tests.
- Whether the llama-server loopback port is a third allowed destination for the data-plane user (open question on #42).

## Consequences

- A crash or compromise in the data plane no longer shares memory, environment or database handles with the gate.
- Every gate call from core is an HTTP request over a local socket and can fail; callers must handle `GateUnavailableError`.
- The gate is a long-running service that must start first; the data plane fails its calls, and does not queue them, while the gate is down.
- Both packages run their TypeScript directly with Node's type stripping and a small resolve hook (`src/ts-hooks.ts`), so gate and core sources avoid syntax that needs transpiling (such as parameter properties).
