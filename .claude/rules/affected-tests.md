# Affected tests only

- While iterating, run only what your change affects: `pnpm turbo run typecheck lint test --affected`, or `pnpm verify` (the same plus the repo checks, on changed packages) (Turborepo compares against `origin/main`, or add `--filter=@eido/gate...` to name a package and its dependents). CI runs everything on every push and pull request.
- Run `pnpm verify` before opening the PR, and whenever a change touches shared config (`tsconfig.base.json`, `turbo.json`, `.dependency-cruiser.cjs`, `packages/schemas`).
- There are no git hooks: nothing runs on commit or push, so CI is the gate.
