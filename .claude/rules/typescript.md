# TypeScript

Guidance, not a style essay. Each rule has its reason. `pnpm turbo run lint typecheck` enforces the ones marked (lint) or (tsc).

- Take types from `@eido/schemas` (generated). Reason: one source of truth, so gate, core and web cannot drift apart.
- Parse external input (files, network, model output) with the schema; do not cast it with `as`. Reason: a cast only silences the compiler, it does not check the data.
- Use `unknown`, not `any`, and narrow it. Reason: `any` turns off checking for everything it touches. (lint)
- Use `import type` for type-only imports. Reason: they vanish at build time, which keeps bundles and import cycles small. (lint, tsc)
- Prefer discriminated unions and `as const` objects over `enum`. Reason: they are plain JavaScript and narrow well in `switch`.
- Use `satisfies` for typed literals. Reason: it checks the shape and keeps the precise literal type.
- Use named exports; default exports only where Next.js requires them (pages, layouts). Reason: names survive renames and autocomplete.
- Use `async`/`await`, and never leave a promise floating. Reason: an unhandled rejection fails silently. (lint)
- Import Node built-ins with the `node:` prefix (`node:fs`). Reason: it is unambiguous next to npm packages.
- No `@ts-ignore`. A `@ts-expect-error` needs a reason after it. Reason: it fails loudly when the problem is fixed, and the next reader knows why. (lint)
- No `!` non-null assertion without a comment saying why it holds. Reason: it is a promise to the compiler that nothing checks.
- Keep logic in small pure functions and the effects at the edges. Reason: pure functions are testable without a browser or network.
- React Server Components by default; add `'use client'` only for state, effects or browser APIs. Reason: less JavaScript shipped and data stays on the server.
- Do not write `.js` files; use TypeScript. The few allowed exceptions are listed with reasons in `scripts/check-no-js.ts`. Reason: JavaScript skips type checking and the type-aware lint rules. (`pnpm turbo run //#check:no-js`)
