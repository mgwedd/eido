# 0009: A local admin page served by the gate on loopback

Status: proposed (#632). The build waits for the owner to accept this ADR; the child issues are listed at the end.
Related: #625, #626, #627, #628, #629, #455, #70, #78, #497

## Context

Running Eido takes shell variables and CLI scripts: `connect`, `enrol-code`, `passkeys`, `reviewed-manifest`, `llama`, the stack commands, and settings exported in every shell (#625). The owner wants setup, configuration, start and stop, model choice, and adding, reconnecting and removing connectors to be part of Eido. They chose a page that the gate serves on the host's loopback and that is opened in a browser on that host. They rejected a Swift menu bar app (a second native codebase, macOS only) and doing it in the phone PWA (admin actions are kept off the phone listener on purpose, ADR 0004 and #78).

Salome develops on Windows, so the page must work on Windows as well as macOS (#455). Platform-specific pieces are adapters added on a platform-neutral base.

The gate is the right host: it already holds the credentials, runs the Gmail loopback OAuth (RFC 8252, `src/internal/connect/oauth.ts`) and the enrolment-code issuer, and the credential boundary holds when the PWA and Next never see a secret. The cost is that the gate gets a new listener and an HTML surface, so this ADR is mostly about who may use it.

## Threats

| Actor                                                                                           | Can do                                                                                                                                    | Relevant to                                                        |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| A website open in the owner's browser                                                           | Navigate or post forms to `http://127.0.0.1:<port>`, embed it in a frame, rebind its own DNS name to 127.0.0.1, read nothing cross-origin | CSRF, DNS rebinding, clickjacking                                  |
| Another local user (another macOS user, another Windows session, the data-plane user after #70) | Connect to any loopback port with any `Host` and `Origin`, list processes and their arguments, bind any free loopback port (squatting)    | Token theft from argv, cookie theft through another port, phishing |
| A process running as the owner (before #70, also as the gate)                                   | Everything the owner can: read the browser profile, the control socket, the vault                                                         | Out of scope, as in ADR 0003 and 0005                              |
| Browser history and its sync (iCloud, Google)                                                   | Keep every URL visited, on other devices too                                                                                              | Token leakage in URLs                                              |

A browser-side check (`Host`, `Origin`, `SameSite`) stops only browsers. A local non-browser client sets every header itself, so the credential, not the header checks, is what stops other local users. Before #70 the gate and data plane run as the same user (ADR 0003, "What is not decided here"); the page does not make that weaker or stronger, and #70 must add the admin port to the data-plane user's denied destinations.

## Decision 1: listener

- A third gate listener, built like the phone listener: a handler mounted on `createGateServer` (`packages/gate/src/internal/http.ts`) on its own loopback TCP port. `EIDO_GATE_ADMIN_PORT`, default **8790** (3000, 8787, 8788, 8789 and 8443 are taken, ADR 0004). It binds `127.0.0.1` only, through `loopbackHost`; it has no host setting, so it cannot be bound to a LAN address.
- The gate refuses to start when the port is taken, so a squatter cannot sit on the admin port while the gate runs.
- Never behind `tailscale serve`. `serve-routes check` fails when any serve route, on any port, targets the admin port, and `apply` refuses to add one. A test proves it.
- The page's one origin is `http://127.0.0.1:8790`. Not `localhost`: the gate never trusts a name a resolver can redirect (ADR 0001, Bridge), and one canonical host means one cookie jar.
- **Host check.** Every request whose `Host` is not exactly `127.0.0.1:<port>` gets 421 before routing. A DNS-rebinding page sends its own name as `Host`, so it is refused; its cookie jar is also a different host.
- **Origin check.** Every POST must carry `Origin: http://127.0.0.1:<port>` exactly, and `Sec-Fetch-Site: same-origin` when the browser sends that header. A missing or other value gets 403. All current browsers send `Origin` on form posts.
- Chrome's local network access prompt also guards public sites from loopback. It is defence in depth and the design does not rely on it.
- **Headers on every response:** `Cache-Control: no-store`; `Referrer-Policy: no-referrer`; `X-Frame-Options: DENY`; `X-Content-Type-Options: nosniff`; `Content-Security-Policy: default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self' https://accounts.google.com; frame-ancestors 'none'; base-uri 'none'`. With no `script-src`, an injected script does not run.
- `GateRequest` gains the `Origin` and `Sec-Fetch-Site` headers, and `Reply` gains HTML and redirect bodies (today `send` writes JSON only). The phone and data-plane listeners keep their behaviour; tests show it.

**Boundary change, stated as required:** `packages/gate/AGENTS.md` lists the `node:http` exceptions. This adds one: the admin listener on one loopback TCP port. The dependency allowlist is unchanged.

Rejected: a Unix socket or named pipe for the page (browsers cannot open one); binding `::1` as well (a second address to defend, with no gain once the origin is `127.0.0.1`); serving the page from Next (Next would then handle credentials, which breaks the boundary).

## Decision 2: who may use it

**Recommended: a one-time launch link from the control socket, then a session cookie.** No platform passkey in the first build.

1. **Issue.** A launcher asks the running gate over the control socket (mode 0600 on macOS; on Windows a named pipe whose ACL is the gate user's, #455) for a launch token: 32 random bytes, single use, 60 s, stored in memory as SHA-256 only. Only a principal that can open the control socket can get one. That is the same trust as `enrol-code` today (#78).
2. **Open.** The launcher opens `http://127.0.0.1:8790/launch?t=<token>` in the default browser without putting the URL in a process argument, because other local users can read process arguments. On macOS it uses `osascript` reading `open location` from a pipe, the same pattern as the Keychain bridge (`infra/keychain-vault.md`). On Windows the adapter must show that its method does not expose the command line to other sessions, or it does not ship.
3. **Exchange.** `GET /launch` consumes the token, sets the session cookie and answers `303` to `/`. A used, expired or unknown token gets a page saying so, with nothing set. Every outcome is audited with hashes only. If an attacker uses a token first, the owner's link fails loudly instead of silently.
4. **Session.** The cookie is `eido_admin_session`, `HttpOnly; SameSite=Strict; Path=/`, with no `Domain`. There is no `Secure` flag because the origin is plain http: loopback traffic does not leave the host, and capturing it needs root or admin. The cookie holds 32 random bytes; the gate keeps only the SHA-256, in memory. A session ends after 30 minutes idle or 4 hours in all. Only one session exists: a new launch ends the old one. A gate restart ends all sessions.

**Why the cookie alone is not enough, and what limits it.** Cookies are scoped by host, not port (RFC 6265, as ADR 0004 notes for the phone). A browser therefore sends `eido_admin_session` to every `127.0.0.1` port. Another local user who listens on `127.0.0.1:<other port>`, and gets the owner's browser to load a page from it, receives the cookie. The limits:

- The session is short-lived, in memory only, and dies at the next launch or restart.
- It carries no signing authority (Decision 4). A stolen session can do what an unsigned local admin action can do and no more, and every such action is audited.
- Changing a security pin needs the secret it protects to be entered again (Decision 5).

A squatter on the admin port while the gate is down receives a dead cookie, because sessions do not survive a restart. A phishing page on that port is possible only while the gate is down; a launcher link only opens after the gate answered on the control socket, and the gate holds the port while it runs.

**Token in URLs and history.** The launch token is in one URL. That URL can stay in history and be synced, but the token is used within seconds, expires after 60 s and is never valid again. No other URL holds a secret. CSRF tokens are in form bodies, never in query strings.

**How this composes with the phone passkey.** The phone passkey's RP ID is the tailnet host and its origin is `https://<host>.ts.net:8443` (`EIDO_WEBAUTHN_RP_ID`, `EIDO_WEBAUTHN_ORIGIN`, ADR 0004). A WebAuthn ceremony on `http://127.0.0.1` cannot use it: an IP address is not a valid RP ID, and the gate compares the origin exactly. The admin page uses no WebAuthn, so it changes nothing about the phone passkey. The two cookies live on different hosts (`127.0.0.1` and `<host>.ts.net`). Each listener reads only its own cookie name and session store: the admin listener refuses a phone session and the phone listener refuses an admin session, each with a test.

**Rejected:**

- **A platform passkey on the host (Touch ID or Windows Hello) for sign-in.** It would remove the launcher after first run. But it needs a second RP (`localhost`, since an IP cannot be an RP ID) and so a second origin and credential class in the ADR 0005 roster. It also needs page script for `navigator.credentials`, and an enrolment bootstrap that still needs the control socket. It also adds a phishing target on `localhost:<port>` while the gate is down. Deferred to a discovery issue (open question 1).
- **Approving a Mac sign-in from the phone** (a pairing code signed with the phone passkey). It reuses the one passkey, but first run has no phone yet, and it adds a signed ceremony to the phone listener for an admin action. Left for the same discovery issue.
- **A static password or a long-lived token in a file.** Either is a reusable secret that other local users and backups can get at.
- **No credential, trusting loopback.** Every local user and process could change settings and connectors.
- **A secret in every URL** (to pair with the cookie). It defeats cookie theft through another port, but puts a live secret in history and in synced history.

## Decision 3: rendering

- Server-rendered HTML forms with no client framework and **no script**: no `<script>` element and no event handlers. Pages that wait (Google sign-in, a phone approval) refresh with `<meta http-equiv="refresh">`. The no-JS rule is therefore met trivially: no `.js` file and no inline script, and the CSP blocks any script. `scripts/check-no-js.ts` is unchanged.
- Templates are TypeScript functions in `packages/gate/src/internal/admin/` that return strings. They use one escaping function for every interpolated value. Tests feed hostile values (`<`, `"`, `&`, `javascript:`) through every field.
- Forms post `application/x-www-form-urlencoded` only, parsed with `URLSearchParams`. Any other content type gets 415, multipart included. The body is capped at the gate's 1 MiB. The phone listener's "JSON only, so the browser preflights" defence does not apply, because an HTML form cannot send JSON.
- **CSRF on every form:** a per-session synchronizer token in a hidden field, compared in constant time. Together with the exact `Origin` check and `SameSite=Strict`, this blocks a cross-site post. A failure gets 403 and is audited.
- Every successful POST answers `303` (post, redirect, get), so a reload never resubmits. Secret fields are `type="password"` with `autocomplete="off"`, and their values are never written back into a page.
- **Styling:** one stylesheet served by the gate, using the same token values as `packages/ui/src/styles/globals.css`, copied in. The gate cannot import `packages/ui` (`gate-imports-schemas-only`), and React or shadcn would change the allowlist. This is a stated exception to `shadcn-first.md`. A repo check fails when the copied tokens drift from `globals.css`.
- **Design:** the page has no design page yet. Under `design-and-plan-traceability.md`, the design pages come first (a child issue) and each UI child links them.
- The dependency allowlist does not change. Any later change to it needs its own ADR amendment.

## Decision 4: signed changes and local settings

| Class                                        | Actions                                                                                                                                                                                                                 | Authority                                                                                                                                                   |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Signed control changes (ADR 0005)            | first pin (#627) and re-pin (`manifest.pin`); permission overrides, file roots and push binding (`policy.set`); enabling a connector again after Remove                                                                 | A fresh assertion from the **phone** passkey. The admin page may prepare the change and show "Approve on your phone" with its payload hash; it never signs. |
| Local admin actions (admin session, audited) | connector credential add, reconnect, remove; enrolment code issue; model choice; start at login; Start and Stop; operational settings (push VAPID subject, owner address, OAuth client ids); keychain create and unlock | The admin session. Each action appends an audit row with actor `local-admin` and hashes only.                                                               |
| Install pins (never edited on the page)      | `EIDO_WEBAUTHN_RP_ID`, `EIDO_WEBAUTHN_ORIGIN`, the allowed hosts and base paths, `EIDO_FILE_HELPER_PATH` and `_SHA256`, `EIDO_GATE_KEYCHAIN_PATH`, data directories, sockets and ports                                  | Shown read-only. Changed by the install commands, then a restart.                                                                                           |

Why the third class stays off the page: a stolen session that could change the file helper pin would run its own code as the gate, and one that could change the WebAuthn origin would point the phone at another origin.

Remove disables the connector and deletes its vault entries. It deletes no data beyond the credential. This is a restrictive change, which ADR 0005 allows without a signature. Enabling the connector again adds authority, so it needs a fresh signed pin on the phone.

Pins are signed on the phone in the first build, so there is one signing key, one RP and no page script. Signing locally with Touch ID or Windows Hello goes with the platform passkey question (open question 1).

## Decision 5: settings store

- `stack.env` (#625) becomes system-managed: the page writes it, and the stack reads it at every start. Secrets stay in the vault: client secrets, the Bridge password, the SimpleFIN access URL, tokens and the keychain password.
- **The gate cannot import the #625 library**, because it lives in `infra/stack` and `gate-imports-schemas-only` allows `@eido/schemas` only. The key table (name, type, class from Decision 4) and the pure parse and serialise functions therefore move to `@eido/schemas` (`stack-settings`), and `infra/stack` and the gate both import them. This keeps one source of truth, as #625 intends, without changing a boundary rule.
- **Writes:**
  - Only keys in the local-admin class are writable; an install pin or an unknown key is refused.
  - The gate writes atomically: a temp file at mode 0600 in the same directory, fsync, then rename. The ACL is set on Windows.
  - Each write carries the SHA-256 of the file as the form read it. A changed file is refused with "changed elsewhere, reload", so the page and a CLI cannot overwrite each other.
  - Each write is audited with the key names and a hash, never values.
- **Applying.** Settings are read at start, so the page says which changed values need a restart and offers Restart where process control exists (Decision 7).
- **Bridge certificate pin.** It is a security pin, but adding Proton needs it. Rule: the pin (path and SHA-256 of the exported public certificate, ADR 0003) is set only in the same form as the Bridge password, and changing the pin deletes the stored Bridge password. A stolen session therefore cannot send a stored password to a new endpoint. The page shows the fingerprint it computed from the named file, never from a connection to a loopback port.

## Decision 6: scope of the first build

Each item is a child issue (listed at the end). Each section shows only what works; there is no stub section.

- **Status.** The doctor checks from #625, rendered as ok, warning or fail, with the fix for each. The gate does not run the checks in-process (it cannot import `infra`), and it does not call core (ADR 0003, Direction). It runs the doctor as a child process: `node infra/stack/bin.ts doctor --json`, with fixed argv, no shell, an allowlisted environment, a 10 s timeout and 64 KiB of output. It parses the output with a `stack-doctor-report` schema from `@eido/schemas`. The doctor's port and health probes report whether core, web and llama answer.
- **First-run setup.**
  - Create or unlock the vault, through the vault adapter (Decision 8). On macOS the keychain password is typed into the page and passed to the Keychain bridge over its private pipe: never argv, env, logs or disk. Failed unlocks are rate-limited.
  - Push: the VAPID subject in `stack.env`; the keys stay in the vault as today.
  - The owner address.
  - The page lists these steps until each one is done.
- **Connectors.**
  - **Add Gmail and Drive.** The page starts the existing one-shot OAuth loopback listener (PKCE S256, state) and redirects to Google. The callback redirects back to the page.
  - **Add Proton (mail and calendar).** Bridge password and certificate pin (Decision 5).
  - **Add SimpleFIN.** The setup token, claimed as `connect` does today.
  - **Reconnect.** Reuses the add flow.
  - **Remove.** Decision 4.
  - **Pinning.** A connector that has never been pinned shows "Pin on your phone" (#627). The page polls until the phone has signed.
  - **Where the manifest comes from.** The page cannot pipe core's `connector-manifest` into the gate, because the gate must never run core code. Instead the reviewed manifests become committed JSON in `@eido/schemas`, with a core test that fails when they differ from core's manifest source. Placing a reviewed manifest is then the gate copying a committed file (open question 3).
- **Model picker (#628).** The page lists the profiles and their state with `llama list --json` and applies one with `llama use <id>`. Both run as child processes, like the doctor, and their output is checked against a schema. A download (`llama fetch`) runs as a tracked background job, and the page refreshes until it ends.
- **Start at login (#629).** On or off, through the process-control adapter.
- **Enrolment code.** Issues a code as `enrol-code` does and shows it once, on a `no-store` page, with its expiry and the phone URL `https://<host>.ts.net:8443/`.

Out of the first build: passkey list and revoke (they stay on the control-socket CLI), audit browsing (it is on the phone), QR codes, and the platform passkey.

## Decision 7: start and stop

The gate cannot stop itself from its own page: once it has stopped, nothing is listening to start it again. The service manager owns the lifecycle, so the #629 job is split in two:

- `com.eido.gate` runs the gate alone, starts at login, and is restarted if it exits. It hosts the admin page, so the page is up whenever the owner is logged in.
- `com.eido.stack` runs core and web; the llama agent already exists. The gate starts first, and the stack waits for the gate's socket (`waitReady`).

The page's **Start** and **Stop** act on `com.eido.stack` and the llama agent, through the process-control adapter. Stop leaves the gate running, with its admin, control and phone listeners. Core is down, so nothing new is proposed. Approvals already pending can still be decided on the phone. **Restart** applies changed settings: it restarts the stack jobs, and for gate settings it restarts `com.eido.gate`. The response is sent first, and the page reloads once the gate answers again.

**When only the gate runs**, Status shows the doctor's result: core, web and llama not answering, with Start when process control exists. The same view appears when the stack crashed or when the owner started the gate by hand. A gate started by hand, outside the service manager, shows no Start, Stop or Restart, because the page cannot manage a process it did not start. It says how it was started, and offers Start at login, which takes effect at the next login. Turning Start at login off disables the job for the next login; it does not stop the running gate.

The gate itself is stopped from outside: by logging out, or with `stack:uninstall`. This is the one shell step left, and stopping is the only thing it is needed for.

## Decision 8: cross-platform adapters

The listener, sessions, CSRF, templates, the settings store, the doctor and the connector flows are platform-neutral, and CI runs their tests on Linux, macOS and Windows (the `gate-os` matrix). Everything else goes behind four adapter seams, each with a fake for tests:

| Seam            | macOS                                                         | Windows (#455)                                                                                                                                  |
| --------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Vault           | Keychain (`EIDO_GATE_KEYCHAIN_PATH`): create, unlock, status  | Now: the dev file vault (`EIDO_GATE_VAULT_FILE` with `EIDO_DEV_VAULT=1`), shown as development-only. Later: DPAPI or Credential Manager (#455). |
| Start at login  | launchd LaunchAgents (#629)                                   | Task Scheduler "at log on" tasks for the same two jobs (#629, #455)                                                                             |
| Process control | `launchctl kickstart`, `bootout` and `disable` in `gui/<uid>` | `schtasks /Run` and `/End`, and enable or disable, on the two tasks                                                                             |
| Browser launch  | `osascript` `open location` from a pipe                       | A method that keeps the URL out of a command line other sessions can read; it ships only once that is shown                                     |
| Local unlock    | Touch ID, only if open question 1 is accepted                 | Windows Hello, only if open question 1 is accepted                                                                                              |

- **Control socket on Windows.** It is a named pipe (`listen` in `http.ts`), and Unix file modes do not apply. The ACL that limits it to the gate user is part of #455; until that ACL exists, a launch token on Windows is only as private as the pipe.
- **Other sessions.** On Windows, other users' sessions (fast user switching, Remote Desktop) share `127.0.0.1`. They take the "another local user" row in the threat table, and the same mitigations apply.
- **A missing adapter.** The page leaves that control out and states the gap in one line that links the issue, for example "Start at login is not available on Windows yet (#629)". It never shows a control that does nothing (`no-placeholders.md`). The page lists the adapters a platform has, and a test per platform checks that every rendered control has a working adapter behind it.

## Consequences

- The owner gets one page for setup and running. The CLIs stay as thin wrappers over the same gate routes, and `stack:admin` is the launcher.
- The gate gets a third listener and an HTML surface. Its trusted base also grows by the `infra` scripts it runs as children (doctor, llama, the service-manager adapters). They run as the gate's user, take fixed argv and are parsed with schemas.
- `stack.env` gets a second writer, guarded by the hash check.
- **Interaction with #70.** After #70, the gate runs as its own user. The owner then cannot open the control socket, so the launcher needs a socket or group the owner can use, and only for launch tokens. The gate user also cannot manage jobs in the owner's login session, so process control needs a design that #70 must supply. Until #70, everything runs as the owner, and the second-user threats above hold only as far as the OS already separates users.

## Open questions for the owner

1. **Is one launcher command acceptable?** Opening the page needs `pnpm stack:admin` (or `stack:setup` on first run). The alternative is a platform passkey (Touch ID or Windows Hello on a `localhost` RP), which drops the launcher after first run but adds page script, a second RP and credential class, and a phishing target while the gate is down. Recommended: launcher now, with a discovery issue for the passkey.
2. **Should pins stay phone-only?** Recommended: yes, one signing key. Local signing goes with question 1.
3. **Can reviewed connector manifests become committed JSON in `@eido/schemas`?** That changes #497 and #627. The alternative, the gate running core's `connector-manifest` command, would run data-plane code with gate privileges and is rejected.
4. **Can #629 split into a gate job and a stack job?** That split is what makes Start and Stop possible from the page.
5. **Is "the gate is stopped only by logout or `stack:uninstall`" acceptable?**

## Child issues to file on acceptance

1. `web` / design: admin page design pages (Status, Setup, Connectors, Model, Start at login, Enrolment) in the design artifact.
2. `gate`: admin listener: port, Host and Origin checks, security headers, HTML and redirect replies in `http.ts`, a `node:http` exception line in `packages/gate/AGENTS.md`, and a test that the phone and data-plane listeners are unchanged.
3. `gate`: launch tokens over the control socket, `/launch`, the admin session store, CSRF, cross-listener cookie refusal tests, and the `stack:admin` launcher (the macOS browser adapter).
4. `infra`: `serve-routes check` and `apply` refuse any route that targets the admin port.
5. `schemas`: the `stack-settings` key table with parse and serialise, moved from #625; the `stack-doctor-report` and `llama list` output schemas.
6. `gate`: settings writes (atomic, hash-checked, classes, audited) and the read-only install pins view.
7. `gate`: Status page from `doctor --json`.
8. `gate`: first-run setup: the vault adapter (Keychain create and unlock over the bridge pipe; the dev file vault on Windows), push subject, owner address.
9. `gate`: connector add, reconnect and remove for Gmail and Drive, Proton (with the Bridge pin rule) and SimpleFIN, with phone-pin handoff (needs #627 and question 3).
10. `schemas` / `core`: committed reviewed manifests with a core equality test (if question 3 is accepted).
11. `gate`: model picker over `llama list`, `use` and `fetch` (needs #628).
12. `infra`: split #629 into `com.eido.gate` and `com.eido.stack`; the process-control and start-at-login adapters for launchd (amends #629).
13. `infra`: Windows Task Scheduler and process-control adapters, and the Windows browser launch (part of #455).
14. `gate`: enrolment code page.
15. `ci`: check that the gate stylesheet's tokens match `packages/ui` `globals.css`.
16. `discovery`: platform passkey (Touch ID, Windows Hello) or phone-approved sign-in for the admin page (open question 1).
17. `infra` (#70 follow-up): owner access to launch tokens and process control across the gate and owner users; deny the admin port to the data-plane user, with a live-host test.
