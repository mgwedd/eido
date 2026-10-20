# apps/web

- Dark by default.
- Follow the design reference in `docs/design.md` (screens, behavior, tokens).
- Use shadcn/ui components (from `@eido/ui`).
- Approval cards are rendered only from the signed payload, never from model text.
- Import only `@eido/schemas` and `@eido/ui` from the workspace; talk to the gate and core over HTTP.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
