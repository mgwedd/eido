# packages/ui

- Role: shadcn/ui components, presentational only. Dark by default.
- Import no other workspace package (`apps/*` or `packages/*`). `apps/web` imports it through the exports map (`@eido/ui/components/*`, `lib/*`, `hooks/*`).
- No data fetching, no gate or core calls, no business logic. Props in, markup out.
- Add components with the shadcn CLI and keep them in `src/components`. Hand-roll only under `.claude/rules/shadcn-first.md`.
- Test: `pnpm turbo run typecheck lint test --filter=@eido/ui`. 90% coverage is enforced; test logic, not markup glue.
- No buttons, menu items or controls that do nothing.

## Theme tokens

One token set lives in `src/styles/globals.css`. `:root` is light, `.dark` is dark; `next-themes` (in `apps/web/components/theme-provider.tsx`) sets the class, dark by default, with system following the OS. Components and pages use token utilities only (`bg-card`, `text-muted-foreground`, `border-approval-border`); no hex, rgb or oklch literals outside `globals.css` (`apps/web/test/tokens.test.ts` fails on them, with three documented exceptions for the manifest, the viewport meta and the generated icon).

| Group    | Tokens                                                                                                                                         |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Surface  | `background`, `foreground`, `card`, `popover` (each with `-foreground`), `border`, `input`, `ring`                                             |
| Action   | `primary`, `secondary`, `accent`, `muted`, `destructive` (each with `-foreground` except `destructive`, `muted-foreground` for secondary text) |
| Sidebar  | `sidebar`, `sidebar-foreground`, `sidebar-primary(-foreground)`, `sidebar-accent(-foreground)`, `sidebar-border`, `sidebar-ring`               |
| Chart    | `chart-1` to `chart-5`                                                                                                                         |
| Approval | `approval`, `approval-foreground`, `approval-border`: an action waiting for the owner's signed approval                                        |
| Confirm  | `confirm`, `confirm-foreground`, `confirm-border`: the confirm card                                                                            |
| Status   | `status-ok`, `status-warn`, `status-error`                                                                                                     |
| Shape    | `radius` and the derived `radius-sm` to `radius-4xl`, `radius-card`                                                                            |

Add a token:

1. Define `--name` in `:root` and in `.dark` in `globals.css`.
2. Map it in `@theme inline` as `--color-name: var(--name);` so Tailwind generates `bg-name`, `text-name`, `border-name`.
3. Use it as a utility. Never inline the value. Add a `name-foreground` partner when text sits on it.
4. Check both modes (press `d` to toggle) and keep contrast at WCAG AA.
