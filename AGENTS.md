# Eido: agent instructions

Eido is a local-first executive assistant. Only the gate (`packages/gate`) holds credentials and executes external writes. This is a pnpm + Turborepo monorepo. Decisions are recorded in `docs/adr/` (start with `0001-gate-package.md`).

## Repo layout

```
apps/web               Next.js + shadcn/ui PWA, dark by default
apps/helper            Eido Helper (Swift, EventKit): placeholder
packages/schemas       JSON Schema source of truth for intents and extractions; codegen to src/generated
packages/gate          tokens, policy, executor, audit (strict dependency allowlist)
packages/core          connectors, sync, index, context assembly, inference queue
packages/ui            shadcn/ui components (presentational)
packages/eslint-config shared ESLint config
packages/typescript-config shared tsconfig bases
services/              Python services for later waves: placeholder
infra/                 launchd, pf, Tailscale, llama-server: placeholder
fixtures/              test fixtures, including the boundary-violation fixture
docs/                  documentation, including docs/adr/
scripts/               repo checks (gate allowlist, secret scan, boundary fixture, exact versions)
```

## Commands

```bash
pnpm install --frozen-lockfile
pnpm build                           # turbo build
pnpm turbo run typecheck lint test   # typecheck, lint and tests
pnpm verify                          # every check CI runs, as one turbo run; tasks limited to changed packages locally
pnpm verify --full                   # the exact CI run: every package
pnpm turbo run //#check:deps         # one repo check alone; also //#check:deps-fixture, //#check:gate-deps,
                                     # //#check:lint-coverage, //#check:no-js, //#check:no-js-fixture,
                                     # //#check:secrets, //#check:versions, //#format:check
pnpm format:check                    # prettier --check (uncached; verify runs it as the cached //#format:check task)
```

## Working rules

Work is issue-driven and worktree-driven. Read the rule file before you do the thing it covers:

- Git: every task in its own worktree cut from `origin/main`; the `sync-main` hook keeps `main` current. `.claude/rules/git-workflow.md`
- Issues: every feature, bug and open question is an issue with acceptance criteria; claim it (assign yourself) before starting. `.claude/rules/github-issues.md`
- No placeholders, fake features or dead ends: leave unfinished work out and open an issue for it. `.claude/rules/no-placeholders.md`
- Design and plan: every UI issue links its design page and plan section; the live artifact wins over exported images. `.claude/rules/design-and-plan-traceability.md`
- Subagents: do small issues directly, use a subagent per independent piece for medium and large ones. `.claude/rules/subagent-development.md`, agent `.claude/agents/issue-implementer.md`
- Commits and PR titles: Conventional Commits. `.claude/rules/conventional-commits.md`
- TypeScript: types from `@eido/schemas`, no `any`, no casts on external input, TypeScript only. `.claude/rules/typescript.md`
- UI: use shadcn components first; hand-roll only when the registries are exhausted or the component would need warping. `.claude/rules/shadcn-first.md`
- Tests: run only the affected tests while iterating, everything before the PR. `.claude/rules/testing.md`, `.claude/rules/affected-tests.md`

## Invariants

- Every external write needs a signed approval.
- No tools for money movement or permanent deletes.
- Tokens are read only by the gate.
- Inference is local.
- The audit log is append-only.

## Conventions

- Conventional commits. Commit as the maintainer.
- No AI attribution in commits, PRs or issues, and no model identifiers in anything pushed.

## Security rules for agents

- Never weaken a boundary rule or the gate allowlist without saying so in the PR description.
- Never commit secrets, tokens or real personal data, including as fixtures.
- Never add `pull_request_target` workflows or third-party actions.
- Never run install scripts of new dependencies.
