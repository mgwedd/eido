# Eido: agent instructions

Eido is a local-first executive assistant. Only the gate (`packages/gate`) holds credentials and executes external writes. This is a pnpm + Turborepo monorepo; see `README.md` for the layout and `docs/adr/0001-gate-package.md` for why.

## Commands

```bash
pnpm install --frozen-lockfile
pnpm turbo run typecheck lint test   # the standard checks
pnpm check:deps                      # dependency-cruiser boundaries (blocking)
pnpm check:deps-fixture              # must show the violation fixture failing
pnpm check:gate-deps                 # gate dependency allowlist
pnpm check:secrets                   # secret scan
pnpm check                           # all of the above
```

## Working rules

Work is issue-driven and worktree-driven. Read the rule file before you do the thing it covers:

- Git: every task in its own worktree cut from `origin/main`; the `sync-main` hook keeps `main` current. `.claude/rules/git-workflow.md`
- Issues: every feature, bug and open question is an issue with acceptance criteria; claim it (assign yourself) before starting. `.claude/rules/github-issues.md`
- No placeholders, fake features or dead ends: leave unfinished work out and open an issue for it. `.claude/rules/no-placeholders.md`
- Commits and PR titles: Conventional Commits. `.claude/rules/conventional-commits.md`
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
