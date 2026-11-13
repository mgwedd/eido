# packages/gate

- No new dependencies without adding them to `ALLOWED_DEPENDENCIES` with a one-line reason.
- No network libraries beyond `fetch`. The one exception is `node:http` over the gate's local sockets (ADR 0003) and the phone listener's one loopback TCP port (#85), which binds `127.0.0.1` or `::1` only. Google's OAuth redirect lands on the phone listener's callback route (#662); there is no loopback callback listener.
- Runs as its own process (`src/main.ts`); it owns `eido-control.db` and imports nothing but `@eido/schemas` (ADR 0003).
- Every change ships with tests.
- Never log token values or payload bodies.
- Everything outside `src/index.ts` is internal; do not export it.
- The admin routes (`src/internal/admin-routes.ts`) only relay the stack supervisor over its socket (`EIDO_GATE_SUPERVISOR_SOCKET`). Reads need a session, changes need a step-up (`elevated`), and no supervisor text reaches a reply unchecked. Start at login (`/admin/login-item`, #664) follows the same rule; off macOS it answers 501 `unsupported_platform`.
- The connector secret routes (`src/internal/connector-secrets.ts`, #661) take a secret only with a signed `policy.set` ceremony whose payload never holds it. The secret goes to the vault and nowhere else: not into a reply, a log line or an audit row.
- The recovery key (`src/internal/recovery.ts`, issue 682) is the owner's single-use way back in when every passkey is lost. It is shown once, in the first enrolment's reply, and again only as the replacement a cancel or a completed recovery returns; only its salted scrypt digest is stored. Using it never enrols anything: `POST /passkey/recover/start` begins a 24-hour delay and pushes an alert, any unrevoked passkey can cancel with a signed assertion, and `POST /passkey/recover/complete` works only after the delay and before the window ends. Public recovery replies are one generic 403, and no audit row holds the key or a hash of a rejected guess.
