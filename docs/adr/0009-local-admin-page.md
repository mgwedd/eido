# 0009: Admin in the web app behind passkey step-up

Status: accepted (owner, 2026-11-05). Decision issue #632; the build issues are listed at the end.
Related: #626, #625, #627, #628, #629, #638, #455, #70, #497; ADR 0003, 0004, 0005

## Context

Running Eido still takes CLI scripts and shell variables: `connect`, `enrol-code`, `passkeys`, `reviewed-manifest`, `llama`, the stack commands. The owner wants setup, connectors, model choice, and start and stop inside Eido, on the phone and in the Mac's browser. The page must also work on Windows (#455).

Two requirements pull against each other:

- **One app.** The admin pages should use the web app, shadcn and the existing design system, not a second UI.
- **The credential boundary.** Next is the data plane. It must never see a secret, and it must not be able to add authority (ADR 0001, 0003).

This ADR keeps the UI in Next and puts every authority decision in the gate, behind a passkey tier per route.

## Decision 1: admin lives in the web app

- The admin pages are routes in `apps/web`, built from `packages/ui`. They are reached at `https://<host>.ts.net:8443`, from the phone or the Mac's browser.
- Every admin action is a gate route on the existing phone listener under `/api/gate`. `tailscale serve` routes `/api/gate` straight to the gate (`infra/tailscale/serve-routes.ts`), so the Next server never sees a request body or the session cookie (`Path=/api/gate`). Next renders the pages; the browser calls the gate directly.
- The gate gets no new listener or port, and no HTML. The phone listener's defences apply unchanged: exact origin, JSON only, and the session cookie.

Rejected: a gate-served page on `127.0.0.1` (an earlier draft of this ADR). It needed a second UI with no shadcn, a launch token, a loopback cookie that leaks to every local port, and a new gate listener. Also rejected: a Swift menu bar app (a second codebase, macOS only).

## Decision 2: step-up tiers, a general gate feature

Every phone route declares one tier in `PHONE_ROUTES`. It replaces today's `session: boolean`. The router enforces the tier before the handler runs, and a test fails when a route has no tier.

| Tier       | What it takes                                                                                                                                                                                                                                                                            | Routes                                                                                                                                                                                                                   |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `public`   | Nothing                                                                                                                                                                                                                                                                                  | Passkey status, the login ceremony, and enrolling with a code. These are today's `session: false` routes.                                                                                                                |
| `session`  | The 12-hour passkey session in use today                                                                                                                                                                                                                                                 | Reads: status, doctor checks, connectors, models, settings shown read-only, audit                                                                                                                                        |
| `elevated` | A fresh passkey assertion with user verification required. It gives a **5-minute elevation bound to the session**, held in memory as a hash only. The elevation is not renewed by use. It ends on lock, sign-out or a gate restart. Every use appends an audit row naming the elevation. | Model choice; start, stop and restart; start at login; removing a connector (a restrictive change); operational settings                                                                                                 |
| `signed`   | A per-action assertion over the payload hash (ADR 0005, unchanged)                                                                                                                                                                                                                       | Anything that adds authority: adding or reconnecting a connector (credential, first pin, scopes); re-pin; `policy.set`; file roots; push binding; **issuing an enrolment code** (adding a device creates a new approver) |

- **Elevation never stands in for a signature.** A `signed` route ignores elevation. An `elevated` route refuses a bare session.
- **Why the elevation is bound and short.** A stolen session cookie gains nothing above `session`. A stolen session together with a live elevation gains five minutes of restrictive and operational changes, all audited, and never a pin, a device or a scope.
- **How it generalises.** A future sensitive feature picks a tier in its route entry and adds no checks of its own. The tier test makes a missing choice fail CI. A new tier needs an ADR amendment.
- **Enrolment from the web app** is `signed`. The CLI `enrol-code` over the control socket stays as the owner-local path (Decision 4).

## Decision 3: typed secrets

The Proton Bridge password, the SimpleFIN setup token and the keychain password are typed by the owner.

**The rule.** The form posts straight to a gate route, never to a Next route or a server action. The value lives only in the input field and is cleared after the post.

**The remaining risk.** The page around the field is code that Next serves. A compromised data plane could serve a page that reads the keystrokes. A CSP does not help, because Next sets the CSP header. A gate-served form under `/api/gate` does not help either: it shares the origin, so a service worker registered by Next can answer for it, and a Next page that opened it can script it.

**Decision: secret entry on its own origin.**

- The three secret fields are minimal pages that the gate serves on a second serve port, `https://<host>.ts.net:8444`. `tailscale serve` maps that port to the gate only.
- The pages run no script and have a strict CSP (`default-src 'none'; form-action 'self'; frame-ancestors 'none'`). `Cross-Origin-Opener-Policy: same-origin` severs the opener.
- The gate refuses the secret routes on 8443, and refuses every other route on 8444.
- The web app links to the page with a single-use handoff id from the signed step (for example, the signed "add Proton" with its pin and scopes). The id is good for 5 minutes and is useless without the session.
- **Accepted residual.** A compromised data plane can still link to a look-alike page instead. The owner checks for `:8444` in the address bar. The fields are rare, one-time entries, and that check is the cost of keeping keystrokes away from the data plane.

Rejected: a CSP on the Next page (set by the party it guards against); same-origin gate pages (defeated by the service worker); accepting the risk outright (these secrets give lasting access and egress, exactly what the gate boundary exists to protect).

## Decision 4: configuration moves into the app; bootstrap is one command

**Configuration in the app.** Connector setup and settings move out of scripts and shell variables and into the app, behind step-up (Decision 2). This ends the spread of CLI scripts and exported variables. Secrets stay in the gate's existing sealed token store (its vault, ADR 0003): the gate is the vault, and the admin UI never sees a secret (Decision 3).

**Bootstrap.** One command: `pnpm stack:setup` (#638), later possibly a signed installer or the Helper. It:

1. installs;
2. registers the services (`com.eido.gate` and `com.eido.stack`);
3. starts them;
4. prints the address of the first-run page.

Everything else happens in the app behind step-up: model download and switch, connectors, the Tailscale check, settings and the doctor.

**The first passkey is proven by presence at the Mac.** Recommended: a **one-time code in the terminal**. `stack:setup` asks the gate over the control socket for the first enrolment code and prints it with the first-run page's address. The owner enters the code on that page and enrols a passkey. Whoever runs the command has a shell on the Mac as the owner, which proves presence, and no new listener is needed.

Rejected for now: a localhost-only first-run page. It would bring back the loopback listener and its port-shared cookie, which Decision 1 removed. It is worth reconsidering when a signed installer or the Helper replaces the command.

`enrol-code` stays as the recovery path for a lost phone, with the same trust as today: whoever can open the control socket.

## Decision 5: Google OAuth

Today's Desktop client redirects to loopback (RFC 8252). That only works when the browser is on the Mac.

**Decision: switch to a Google web client** that redirects to `https://<host>.ts.net:8443/api/gate/connect/google/callback`. It lands on the gate, which already holds the client secret in the vault and checks PKCE and state.

- The same flow works from the phone and from the Mac. The CLI `connect` prints the same URL.
- **Trade-off.** Setup gains one Google Cloud step: registering the redirect URI. A renamed tailnet host needs a new URI. The host name becomes known to Google, though it is already public in certificate transparency logs for `ts.net`.
- The rejected option, Mac-only in the first build, keeps two Google flows and makes the phone a second-class admin client.

## Decision 6: the supervisor

A small process in `infra/stack` that runs as the owner. The gate runs no repo scripts or host tools.

- **What it owns.** The doctor checks (#625), model profiles (#628: list, use, and fetch as a tracked job), start, stop and restart, start at login (#629), and writes to `stack.env`.
- **Its socket.** A Unix socket at mode 0600 in a 0700 directory that the owner owns. On Windows, a named pipe with an owner-only ACL (#455). No TCP.
- **Its calls.** A fixed RPC set, HTTP over the socket. Bodies are validated on both sides with schemas from `@eido/schemas`: `stack-doctor-report`, `stack-job-status`, `stack-model-list` and `stack-settings`. Every other route is 404.
- **The gate is only a client.** It checks the tier, audits, calls the supervisor and returns the result. The supervisor never receives a token, a password or a vault handle. A compromised supervisor can lie about status or stop the stack. It cannot reach a credential or add authority.
- **Jobs.** The supervisor is the `com.eido.stack` job, which already parents core and web through `supervise.ts`. `com.eido.gate` is its own job. **Stop** stops core and llama, and leaves the gate, the supervisor and web running, so the admin page stays reachable. Start and Restart reverse it.
- **Settings.** Writes go through the supervisor with the file's SHA-256 as read: a changed file is refused. The gate audits first, with key names and a hash, never values. Secrets never go to `stack.env`.
- **#70.** After #70, the gate user gets the supervisor socket through a group or an ACL, and the data-plane user does not. The supervisor never gets gate privileges.

## Decision 7: what may change from the page

| Class                   | Authority                     | Examples                                                                                                                                       |
| ----------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Signed control changes  | `signed`                      | First pin, re-pin, `policy.set`, file roots, push binding, connector add and reconnect, enrolment code                                         |
| Local admin actions     | `elevated`                    | Model choice, start, stop and restart, start at login, remove connector, operational settings                                                  |
| Install pins, read-only | None (changed by the install) | `EIDO_WEBAUTHN_RP_ID` and `_ORIGIN`, allowed hosts, `EIDO_FILE_HELPER_PATH` and `_SHA256`, the keychain path, data directories, sockets, ports |

- **Reviewed connector manifests** become committed JSON in `@eido/schemas`, with a core test that fails when they differ from core's source. The gate never runs core code to place one.
- **Bridge certificate pin.** It is set only together with the Bridge password, on the secret page. Changing it deletes the stored password.

## Decision 8: Windows

Platform pieces are adapters behind seams. The vault is the Keychain on macOS; on Windows it is the dev file vault for now, and later DPAPI or Credential Manager (#455). The other seams are start at login (launchd or Task Scheduler), process control, and the supervisor socket (Unix socket or ACL'd pipe). A missing adapter hides its control and states the gap, linking the issue. The page never shows a control that does nothing.

## Consequences

- One UI, on the phone and the Mac, from the design system. Configuration lives in the app, the secrets in the gate's vault, and bootstrap is one command. The CLIs become thin wrappers over the same gate routes.
- The gate gains a tier on every route, an elevation store, a second serve port for secret entry, and a supervisor client. It gains no new listener and runs no scripts.
- Next stays credential-free. Its remaining reach is the accepted look-alike risk in Decision 3.

## Later, not in this build

- **Approval prompts by email**, CIBA-style, for example through Resend. Email may carry only the prompt; the approval stays a passkey assertion. Sending to an external service needs its own decision, because Eido is local-first.
- Vault create and unlock on the page. `stack:setup` already creates the keychain over a TTY, and Status shows a locked vault with its fix.
- Windows adapters (#455).

## Open questions for the owner

1. Is a second serve port (8444) for secret entry acceptable, or is the residual risk on 8443 accepted instead?
2. Should an elevation last 5 minutes, and should it also end when the PWA goes to the background?

## Build issues

Filed on acceptance, each linking this ADR and #626. The Later items above are not filed until picked up.

1. #643, `gate`: step-up tiers as a general feature. This covers the elevation primitive, a tier on every `PHONE_ROUTES` entry with a test that fails on a route with none, and the existing routes moved to their tiers (enrolment code issuance becomes `signed`).
2. #644, `infra`: the supervisor (Decision 6), with its schemas in `@eido/schemas`. Builds on #638 and #628.
3. #645, design: the Admin pages in the design artifact. These are Status, Connectors (add, reconnect, remove, secret handoff), Model, Start/Stop, Add device, and the step-up prompt states.
4. #646, `web` and `gate`: the admin page itself, with secret entry on `:8444`, the Google web client and the `stack:setup` first code. Needs 1, 2 and 3.
