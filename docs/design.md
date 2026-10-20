# Web design reference

The UI for `apps/web` follows the "Eido UI concept" design canvas:
https://claude.ai/code/artifact/7ea3f3d2-ffae-4035-a7e1-3345a19afde8

The canvas is the visual reference, not source code. Build the pages with shadcn/ui components from `@eido/ui`, and show only real data (see `.claude/rules/no-placeholders.md`). The sample text in the canvas is illustrative.

## Screens

| Screen                                       | Issue    |
| -------------------------------------------- | -------- |
| App shell, navigation, installable           | #31      |
| Today (needs you, brief, due soon)           | #34, #54 |
| Approval queue (phone swipe, desktop review) | #33      |
| Ask                                          | #35      |
| Activity                                     | #36      |

Phone navigation is a four-item bottom bar: Today, Queue (with count), Ledger, Activity.

## Approval queue behavior

- Phone: drag a card right past 110px to approve, left past 110px to reject. Buttons for approve, reject and edit do the same.
- A progress label ("n of N") and a toast confirm each decision. An empty queue shows a "Queue clear" end state.
- Badges: "Approval" (orange) for gated writes, "Confirm" (blue) for fields to confirm.
- Card content comes only from the signed payload.

## Tokens (dark theme)

| Role             | Value     |
| ---------------- | --------- |
| Background       | `#09090b` |
| Nav bar          | `#0f0f12` |
| Card surface     | `#121215` |
| Border           | `#27272a` |
| Row divider      | `#1f1f23` |
| Foreground       | `#fafafa` |
| Secondary text   | `#d4d4d8` |
| Muted text       | `#a1a1aa` |
| Overdue / danger | `#f87171` |

- Fonts: Geist (UI) and Geist Mono (identifiers, numbers), from Google Fonts.
- Radii: 16px cards, 12px icon buttons, fully rounded pills.
- Touch targets on phone are at least 44px.
- The primary call to action on Today is an inverted card (light background, dark text).

Where these overlap with the shadcn theme in `packages/ui/src/styles/globals.css`, set the theme variables to these values rather than hard-coding colors in components.
