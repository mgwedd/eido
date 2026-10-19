# Subagent development

Guidance, not a mandate. A subagent costs a brief, a context rebuild and a report; use one only when that cost buys something.

## When not to use a subagent

- The issue is small and straightforward: a few files, a clear fix, a doc edit. Do it directly.
- You already hold the context and the change is one coherent piece. A hand-off loses detail.
- Two pieces touch the same files. They run one after the other, by one writer.
- The brief would take longer to write than the work.

## When to use one

- Medium and large issues: prefer one subagent per independent piece, one issue and one PR each.
- Run several in parallel only when their files do not overlap. Split file ownership up front.
- Reading across many files where you only need the conclusion.
- Never dispatch two writers on the same files.

## What a good brief contains

- The issue number. The agent reads the issue itself.
- The claim step: assign the issue to the authenticated gh user, then re-read to confirm no one else is on it (`.claude/rules/github-issues.md`). If it is assigned to someone else, stop and ask.
- The worktree path and branch, cut from `origin/main` (`.claude/rules/git-workflow.md`).
- The files it owns, and the files it must not touch.
- The rules to read before it starts, and the design and plan links from the issue.
- Done criteria: the issue's acceptance criteria and the checks to run.
- How to report: PR link, CI status, anything not done or not verified, and follow-up issues opened.

`.claude/agents/issue-implementer.md` is a project subagent that already carries the repo flow; give it the issue number and any extra constraints.

## The dispatcher's job

- Check the PR against the issue before telling the owner it is done: read the diff, compare it with each acceptance criterion, confirm CI is green.
- A subagent's report is a claim, not proof. Verify it with the diff and the check results.
- There is no review routing or required reviewer. The owners are Michael and Salome; the dispatcher's check above is the review step.
- Subagents never merge.
