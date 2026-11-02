# scripts

- Role: repo checks (`check-*.ts`, `secret-scan.ts`, `verify.ts`), run directly by Node (`node scripts/secret-scan.ts`): no build step, no `tsx`.
- Node strips types, so write erasable syntax only: no `enum`, `namespace` or parameter properties; `import type` for types; relative imports with the `.ts` extension. `erasableSyntaxOnly` in `tsconfig.json` enforces it.
- Each script exports its logic as pure functions and runs `main()` only under `if (import.meta.main)`, so `*.test.ts` can import it without side effects.
- Keep the root `package.json` script names stable; they are what CI and `pnpm verify` call.
- Test: `pnpm turbo run typecheck lint test --filter=@eido/scripts`.
