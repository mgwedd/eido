# packages/gate

- No new dependencies without adding them to `ALLOWED_DEPENDENCIES` with a one-line reason.
- No network libraries beyond `fetch`. The one exception is `node:http` over the gate's local sockets (ADR 0003) the phone listener's one loopback TCP port (#85), which binds `127.0.0.1` or `::1` only, and the `connect` command's one-shot OAuth callback listener (#98, `src/internal/connect/oauth.ts`), which binds `127.0.0.1` on an ephemeral port, accepts one callback and closes, with a timeout.
- Runs as its own process (`src/main.ts`); it owns `eido-control.db` and imports nothing but `@eido/schemas` (ADR 0003).
- Every change ships with tests.
- Never log token values or payload bodies.
- Everything outside `src/index.ts` is internal; do not export it.
- The admin routes (`src/internal/admin-routes.ts`) only relay the stack supervisor over its socket (`EIDO_GATE_SUPERVISOR_SOCKET`). Reads need a session, changes need a step-up (`elevated`), and no supervisor text reaches a reply unchecked. Start at login (`/admin/login-item`, #664) follows the same rule; off macOS it answers 501 `unsupported_platform`.
