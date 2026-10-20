# 0002: Keep ESLint and Prettier instead of Biome

Status: accepted

## Context

Issue #1 preferred Biome for linting and formatting. The Next.js and shadcn/ui scaffold ships with ESLint, and the Next-specific rules in the scaffold's ESLint setup have no Biome equivalent. Replacing them would mean either losing those checks or maintaining custom rules on top of Biome.

## Decision

- Linting uses ESLint with the shared config in `packages/eslint-config`, covering TypeScript files.
- Formatting and format checking use Prettier (`prettier --check .`), with the Tailwind class-sorting plugin.
- CI runs `format:check` and `lint` with TypeScript file coverage, so both tools are blocking.

## Consequences

- Two tools instead of one. Each has its own config, and both run in CI and locally through `pnpm verify`.
- The Next.js and shadcn/ui rules keep working without custom glue.
- This choice departs from the preference in issue #1, so it is recorded here rather than left implicit.

## Revisit

Revisit when Biome gains equivalents for the Next-specific rules we depend on. At that point, a single-tool setup can replace ESLint and Prettier in one change, with a new ADR that supersedes this one.
