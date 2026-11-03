# packages/schemas

- Role: JSON Schema source of truth for intents and extractions. `src/generated` comes from `scripts/codegen.ts` and is not committed (gitignored). It is written on `pnpm install` (root `postinstall`) and by the turbo `codegen` task, which `typecheck`, `lint`, `test`, `build` and `dev` depend on. After a schema edit outside turbo, run `pnpm --filter @eido/schemas codegen`.
- Import no other workspace package (`apps/*` or `packages/*`). Every other package may import this one.
- Edit the schemas under `schemas/`, then regenerate. Never hand-edit `src/generated`.
- A schema change touches gate, core and web; say so in the PR and run the full `pnpm verify --full`.
- Test: `pnpm turbo run typecheck lint test --filter=@eido/schemas`. Generated code is excluded from coverage; the rest is held to 90%.
