# No placeholders, fake features or dead ends

- Ship only what works. Nothing is better than a misleading placeholder.
- Never add a button, menu item, route, setting or API endpoint that does nothing, says "coming soon", or pretends to work.
- Never add a stub that returns canned or invented data where real data belongs. Test fixtures are the only exception, and they stay out of the real app. Never put real personal data in fixtures.
- Never leave a code path that ends in `TODO`, `throw new Error("not implemented")` or a silent no-op where the user expects an effect.
- Never show made-up numbers, example cards or sample text as if they were the user's data. (The bootstrap stubs in `packages/*/src/index.ts` and the README-only directories are scaffolding named in issue #1, not product features.)
- If part of a task must wait, leave it out entirely and open a GitHub issue for it: `gh issue create --repo mgwedd/eido --title "..." --body "..."`. Say what is missing, why, and what done looks like.
- If you hit a bug you cannot fix within the task, open a GitHub issue with the evidence (error text, failing test, steps) instead of working around it quietly.
- Link the issues in the PR body and in your report, so the gap is visible rather than hidden in the code.
