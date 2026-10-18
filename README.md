# Eido

Private AI executive assistant that runs on your Mac. Local inference; only the gate holds credentials and executes external writes.

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

## Build

Requires Node 24 (`.node-version`) and pnpm 10 (pinned by `packageManager`; run `corepack enable`).

```bash
pnpm install --frozen-lockfile
pnpm turbo run typecheck lint test
pnpm check            # also runs boundary, allowlist, secret, exact-version and format checks
pnpm check:versions   # exact-version pinning check on its own
```

Turborepo telemetry: set `TURBO_TELEMETRY_DISABLED=1` in CI, and run `pnpm turbo telemetry disable` on your machine.

Add shadcn components with `pnpm dlx shadcn@latest add <component> -c apps/web`.

## License

Apache-2.0. See `LICENSE` and `NOTICE`.
