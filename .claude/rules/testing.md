# Testing

- The interface is pnpm + Turborepo. Local runs and agents use `pnpm turbo run typecheck lint test` (everything), or the affected subset below. `pnpm check` adds the boundary, allowlist and secret checks that CI also runs.
- Tests are Vitest, next to the code as `*.test.ts`. Prefer plain functions you can test without a browser or network. Anything touching the gate ships with tests (see `packages/gate/AGENTS.md`).
- Do not call `vitest`, `eslint` or `tsc` directly when a turbo task does the job.
- Never put real tokens, personal data or live-service calls in tests.
