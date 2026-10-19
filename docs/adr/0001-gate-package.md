# 0001: The gate is a separate package with its own dependency allowlist

Status: accepted

## Context

Eido's main boundary is that only the gate holds credentials and executes external writes. Everything else (connectors, sync, index, inference, the web app) must be unable to reach tokens or perform writes except by asking the gate through its intent API, which requires a signed approval.

## Decision

- The gate lives in `packages/gate` with a minimal public entry point (`src/index.ts`, the intent API client). Token store, executor and audit writer are internal.
- dependency-cruiser enforces the boundary in CI (blocking): nothing outside `packages/gate` may import gate internals. A fixture that breaks the rule must make the check fail, and CI asserts that it does.
- `packages/gate/ALLOWED_DEPENDENCIES` lists every package the gate may depend on, each with a one-line reason. CI fails on anything else, so a new dependency in the gate is always a visible, reviewed change.
- The gate uses `fetch` for network access and no other network libraries, with one exception below.

## Amendment: Proton Bridge clients (#195)

Proton Mail has no HTTP API the gate can call; Proton Bridge exposes the mailbox as IMAP and SMTP on this machine. `fetch` speaks neither, so the allowlist adds two packages for Bridge only:

- `imapflow` (IMAP) and `nodemailer` (SMTP and MIME composing), pinned to exact versions, with their transitive packages listed and checked for install scripts in `packages/gate/ALLOWED_DEPENDENCIES`.
- They connect to Bridge on loopback only: `bridgeConfig` refuses any host but `127.0.0.1`, `::1` or `localhost`. No other code in the gate may use them for another destination.
- The Bridge password lives in the vault and is read only when a connection opens; it is never in configuration, logs, audit rows or responses.
- No code path deletes mail permanently: the adapter exposes no delete, expunge or mailbox removal, the gate's lint config bans calling them and the `\Deleted` flag, and the tests check the commands sent to a fake Bridge.

## What the allowlist protects

Every dependency in the gate runs with access to tokens. A compromised or careless package there would be a credential leak, so the supply chain for this package is kept as small as possible. Install scripts are off by default repo-wide.

## Later

Split the gate into its own process, running as a separate OS user, so the boundary is enforced by the operating system as well as by the import graph. The package boundary is the first step toward that. The process split is [ADR 0003](0003-plane-split.md); the separate OS users are #70.
