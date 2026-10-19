# packages/gate

- No new dependencies without adding them to `ALLOWED_DEPENDENCIES` with a one-line reason.
- No network libraries beyond `fetch`. The one exception is `node:http` over the gate's local sockets (ADR 0003).
- Runs as its own process (`src/main.ts`); it owns `eido-control.db` and imports nothing but `@eido/schemas` (ADR 0003).
- Every change ships with tests.
- Never log token values or payload bodies.
- Everything outside `src/index.ts` is internal; do not export it.
