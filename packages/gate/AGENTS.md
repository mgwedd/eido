# packages/gate

- No new dependencies without adding them to `ALLOWED_DEPENDENCIES` with a one-line reason.
- No network libraries beyond `fetch`.
- Every change ships with tests.
- Never log token values or payload bodies.
- Everything outside `src/index.ts` is internal; do not export it.
