# Eido

<img width="1035" height="727" alt="Screenshot 2026-10-18 at 5 06 48 PM" src="https://github.com/user-attachments/assets/b81ae418-718e-4daf-9dcd-e2e5d457fc2a" />

A private, local-first executive assistant for your Mac. It reads your mail, calendar and files, proposes actions, and does nothing external until you approve it with a passkey.

- **Local inference.** The model runs on your machine. Nothing is sent to a hosted model.
- **One door for writes.** Only the gate (`packages/gate`) holds credentials and executes external writes, and every write needs a signed approval.
- **Reachable from your devices.** The web app runs on the Mac behind Tailscale, with no public surface.

> Status: early build. The web app is a bootstrap page; features are tracked as GitHub issues (start with the MVP epic, #5). Host hardening (vault, service supervision, sandboxing) is built Mac-first.

## How approvals work

Eido proposes an action as an intent. Low-risk, reversible actions run automatically and can be undone. Anything else waits in the approval queue until you sign it with a passkey, and only then does the gate execute it. Every step is recorded in an append-only audit log.

## Quickstart

Requires Node 24 (`.node-version`) and pnpm 10 (pinned by `packageManager`; run `corepack enable`).

```bash
pnpm install --frozen-lockfile
pnpm --filter @eido/web dev      # web app at http://localhost:3000
pnpm turbo run typecheck lint test
pnpm check                       # also runs boundary, allowlist, secret, exact-version and format checks
```

## Layout

```
packages/schemas       JSON Schema source of truth for intents and extractions
packages/gate          tokens, policy, executor, audit (strict dependency allowlist)
packages/core          connectors, sync, index, context assembly, inference queue
packages/ui            shadcn/ui components (presentational)
packages/eslint-config shared ESLint config
packages/typescript-config shared tsconfig bases
apps/web               Next.js + shadcn/ui PWA, dark by default
apps/helper            Eido Helper (Swift, EventKit): placeholder
services/              Python services for later waves: placeholder
infra/                 launchd, pf, Tailscale, llama-server: placeholder
fixtures/              test fixtures, including the boundary-violation fixture
docs/adr/              architecture decision records
scripts/               repo checks (gate allowlist, secret scan, boundary fixture, exact versions)
```

## Contributing

Work is issue-driven and worktree-driven: pick an issue, assign yourself, and work in your own worktree. Read [AGENTS.md](AGENTS.md) and the rules in `.claude/rules/` first. Commits and PR titles follow Conventional Commits.

Turborepo telemetry: set `TURBO_TELEMETRY_DISABLED=1` in CI, and run `pnpm turbo telemetry disable` on your machine.

Add shadcn components with `pnpm dlx shadcn@latest add <component> -c apps/web`.

## License

Apache-2.0. See `LICENSE` and `NOTICE`.
