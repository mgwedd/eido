# Testing

- The interface is pnpm + Turborepo. Local runs and agents use `pnpm turbo run typecheck lint test` (everything), or the affected subset below. `pnpm check` adds the boundary, allowlist and secret checks that CI also runs.
- Tests are Vitest, next to the code as `*.test.ts` (in `apps/web`, under `test/`). Prefer plain functions you can test without a browser or network. Anything touching the gate ships with tests (see `packages/gate/AGENTS.md`).
- Do not call `eslint` or `tsc` directly when a turbo task does the job. Call `vitest` directly only for a one-shot `vitest related` or `--changed` run, or through the `test:watch` task below.
- Never put real tokens, personal data or live-service calls in tests.

## Coverage

- `pnpm turbo run test` runs `vitest run --coverage` (v8 provider) in `apps/web`, `packages/ui`, `packages/gate`, `packages/core` and `packages/schemas`, and fails when a package is below 90% on lines, statements, functions or branches. The thresholds live in each package's `vitest.config.ts`. CI prints the per-package table in the job summary (`scripts/coverage-summary.mjs`).
- A package with no source yet passes: the threshold applies to the files that exist.
- Exclusions are explicit and short, in the `coverage.exclude` of the package's `vitest.config.ts`, one reason comment per entry. Allowed: test files, generated code (`packages/schemas/src/generated`), config files, type-only files, and Next route glue with no logic (`layout.tsx`, `loading.tsx`, `error.tsx`, `manifest.ts`).
- Never exclude logic. Move logic out of glue into a pure function and test it. Raising coverage means writing tests, not adding exclusions; say so in the PR if you must add one.

## Watch mode

- Humans: `pnpm turbo run test:watch --filter=<pkg>` (for example `--filter=@eido/gate`) starts Vitest in watch mode and reruns on file change. It does not run coverage.
- Agents: one-shot runs only, since they exit with a status. Use `pnpm turbo run typecheck lint test --affected`, or a `vitest related` or `--changed` run through turbo. Agents do not run or monitor watch mode.
