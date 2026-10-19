# GitHub issues

- Work comes from GitHub issues on `mgwedd/eido`. Michael and Salome each run their own agent fleet; the issue is the hand-off between them, so it must make sense to an agent with no other context.
- Find or open the issue before starting work. Track every TODO, bug and open question as an issue, not in code comments, docs or chat.
- One issue is one PR-sized piece of work. Larger work is a parent issue whose checklist links its child issues (see #1 for the shape).
- Labels: exactly one type, `enhancement` (feature), `bug` or `discovery` (a question to investigate; done means the answer is written in the issue and follow-ups are filed). Plus one area: `gate`, `core`, `schemas`, `web`, `infra` or `ci`.
- Claim before work: an agent starts on an issue only once it is assigned to the authenticated gh user (`gh api user --jq .login`). Assign it first with `gh issue edit N --repo mgwedd/eido --add-assignee @me`, then re-read the issue to confirm no one else is on it. If it is assigned to someone else, do not start: ask them. This keeps the two fleets from colliding.
- Title: `scope: imperative summary`, for example `web: Approval queue page`.
- Body, short and concrete, no filler:

  ```
  Part of #N. Needs #M.            (only the lines that apply)

  ## What
  - the change, naming the files, routes or functions involved

  ## Acceptance criteria
  - [ ] an outcome a reviewer can check by a test or a stated manual step

  ## References
  UI design: link to the design artifact page (web and UI issues)
  Plan: the plan section
  ```

- Status is on the issue: `in-progress` when you claim it, `in-review` when the PR opens, `blocked` when waiting on another issue (name it in a comment and in the body's `Needs` line). Remove the label when it no longer applies. Issues and PRs are the only tracker; do not track work in chat or files.
- Use the issue and PR templates in `.github/`.

- The PR body says `Closes #N`. Tick acceptance criteria as they are met. A finding that changes the scope goes in an issue comment, or a new issue.
- Create issues with `gh issue create --repo mgwedd/eido --title ... --label ... --assignee ... --body-file ...`.
- No AI attribution or model identifiers in issue or PR bodies.
