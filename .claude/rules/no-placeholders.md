# No placeholders, fake features or dead ends

- Ship only what works. Nothing is better than a misleading placeholder.
- Never add a button, menu item, route, setting or API endpoint that does nothing, says "coming soon", or pretends to work.
- Never add a stub that returns canned or invented data where real data belongs. Test fixtures are the only exception, and they stay out of the real app. Never put real personal data in fixtures.
- Never leave a code path that ends in `TODO`, `throw new Error("not implemented")` or a silent no-op where the user expects an effect.
- Never show made-up numbers, example cards or sample text as if they were the user's data. (The bootstrap stubs in `packages/*/src/index.ts` and the README-only directories are scaffolding named in issue #1, not product features.)
- If part of a task must wait, leave it out entirely and open a GitHub issue for it: `gh issue create --repo mgwedd/eido --title "..." --body "..."`. Say what is missing, why, and what done looks like.
- If you hit a bug you cannot fix within the task, open a GitHub issue with the evidence (error text, failing test, steps) instead of working around it quietly.
- Link the issues in the PR body and in your report, so the gap is visible rather than hidden in the code.
- No explanatory how-it-works text in the UI. Definitions go on the page's side board; use a tooltip only where something needs clarifying.
- UI copy never claims something no issue implements, for example that a payload was hashed on the device before #94 ships.
- The design pages are clickable prototypes. Their state switchers, "illustrative" tags, sample data and spec-board annotations are for review and do not ship. Every other control in a design is a requirement: build it fully, or leave it out and open an issue. A shipped control never does nothing, never fakes a result, and never shows a state it cannot reach.
- In the design, generated or user-written text (chat, answers, briefs, message bodies) is lorem ipsum, so it is never mistaken for copy to hardcode. Real labels, headings and state names are the copy to build.
- Before opening a PR, click every control you added and confirm it has an effect, and list in the PR body any designed control you left out with its issue.
