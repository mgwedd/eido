# apps/web

- Dark by default.
- Follow the design reference in `docs/design.md` (screens, behavior, tokens).
- Use shadcn/ui components (from `@eido/ui`).
- Approval cards are rendered only from the signed payload, never from model text.
- Import only `@eido/schemas` and `@eido/ui` from the workspace; talk to the gate and core over HTTP.
- UI states are tested with a state table per page: fixtures in `test/fixtures/` (synthetic, test-only, enforced by `//#check:deps`) and `describeStates` from `test/render-states.tsx`. Convention and rules: `.claude/rules/testing.md`. Worked example: `test/connection-banner.states.test.tsx`.
