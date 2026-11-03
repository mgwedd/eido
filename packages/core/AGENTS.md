# packages/core

- Role: connectors, sync, index, context assembly and the inference queue. It never holds credentials and never executes external writes; it asks the gate.
- Import `@eido/gate` only through its public entry point (`src/index.ts`) and `@eido/schemas` for types. Never import gate internals, `apps/*` or `@eido/ui`. `apps/web` does not import core; it talks to it over HTTP.
- The data plane runs as its own process (`src/main.ts`) with an allowlisted environment. It owns `eido-data.db`, never opens or names the gate's `eido-control.db`, and reaches the gate only through `createIntentClient` and `createAuditClient` (ADR 0003).
- Core's API has no auth: the tailnet is the trust boundary and `tailscale serve` (#178) is the only way in. It binds `127.0.0.1` or `::1` only (`EIDO_CORE_HOST`, default `127.0.0.1`; `EIDO_CORE_PORT`, default 8789) and answers only its listen address and `EIDO_CORE_ALLOWED_HOSTS` as Host (421 otherwise). `EIDO_CORE_BASE_PATH` (default none) sets the prefix routes are served under.
- Inference is local. No calls to hosted model APIs.
- Test: `pnpm turbo run typecheck lint test --filter=@eido/core`. Tests are Vitest next to the code; 90% coverage is enforced.
- Do not read tokens, log payload bodies, or add logic that is untested.
