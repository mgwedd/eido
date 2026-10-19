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
pnpm boundaries                      # package boundary checks (turbo)
pnpm check:deps                      # dependency-cruiser boundaries (blocking)
pnpm check:deps-fixture              # must show the violation fixture failing
pnpm check:gate-deps                 # gate dependency allowlist
pnpm check:no-js                     # no stray .js/.jsx/.mjs/.cjs files (allowlist in the script)
pnpm check:no-js-fixture             # self-test: the check still catches a stray JS file
pnpm check:secrets                   # secret scan
pnpm check:versions                  # exact-version pinning check
pnpm format:check                    # prettier --check
pnpm check                           # all of the above, including format:check
```

## Working rules

Work is issue-driven and worktree-driven. Read the rule file before you do the thing it covers:

- Git: every task in its own worktree cut from `origin/main`; the `sync-main` hook keeps `main` current. `.claude/rules/git-workflow.md`
- Issues: every feature, bug and open question is an issue with acceptance criteria; claim it (assign yourself) before starting. `.claude/rules/github-issues.md`
- No placeholders, fake features or dead ends: leave unfinished work out and open an issue for it. `.claude/rules/no-placeholders.md`
- Commits and PR titles: Conventional Commits. `.claude/rules/conventional-commits.md`
- TypeScript: types from `@eido/schemas`, no `any`, no casts on external input, TypeScript only. `.claude/rules/typescript.md`
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
