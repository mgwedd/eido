# Eido

Private AI executive assistant that runs on your Mac. Local inference; only the gate holds credentials and executes external writes.

## Layout

```
packages/schemas   JSON Schema source of truth for intents and extractions
packages/gate      tokens, policy, executor, audit (strict dependency allowlist)
packages/core      connectors, sync, index, context assembly, inference queue
packages/ui        shadcn/ui components (presentational)
apps/web           Next.js + shadcn/ui PWA, dark by default
apps/helper        Eido Helper (Swift, EventKit): placeholder
services/          Python services for later waves: placeholder
infra/             launchd, pf, Tailscale, llama-server: placeholder
docs/adr/          architecture decision records
scripts/           repo checks (gate allowlist, secret scan, boundary fixture)
```

## Build

Requires Node 24 (`.node-version`) and pnpm 10 (pinned by `packageManager`; run `corepack enable`).

```bash
pnpm install --frozen-lockfile
pnpm turbo run typecheck lint test
pnpm check            # also runs boundary, allowlist and secret checks
```

Turborepo telemetry: set `TURBO_TELEMETRY_DISABLED=1` in CI, and run `pnpm turbo telemetry disable` on your machine.

Add shadcn components with `pnpm dlx shadcn@latest add <component> -c apps/web`.

## License

Apache-2.0. See `LICENSE` and `NOTICE`.
