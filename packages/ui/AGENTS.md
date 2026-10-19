# packages/ui

- Role: shadcn/ui components, presentational only. Dark by default.
- Import no other workspace package (`apps/*` or `packages/*`). `apps/web` imports it through the exports map (`@eido/ui/components/*`, `lib/*`, `hooks/*`).
- No data fetching, no gate or core calls, no business logic. Props in, markup out.
- Add components with the shadcn CLI and keep them in `src/components`. Hand-roll only under `.claude/rules/shadcn-first.md`.
- Test: `pnpm turbo run typecheck lint test --filter=@eido/ui`. 90% coverage is enforced; test logic, not markup glue.
- No buttons, menu items or controls that do nothing.
