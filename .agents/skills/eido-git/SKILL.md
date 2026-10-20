---
name: eido-git
description: Does all the git and GitHub work for a developer who doesn't use git. Creates the branch, commits, pushes, merges main in, opens the pull request, then fixes CI until it is green. Use whenever the user wants to start work, save, share, or submit changes, or says things like "save this", "send this up", "open a PR", "is CI green".
---

# eido-git

The user may not know git. Do every git and `gh` step yourself. Ask only about things git cannot decide for you: what the work is for, or which side of a real conflict is right. Follow `.agents/rules/git-for-salome.md` for how to talk.

Repo is `mgwedd/eido`. Main checkout: `<root>/eido`. Worktrees: sibling `<root>/eido-worktrees/<slug>`. On Windows use the same sibling layout and forward slashes in git paths.

## 1. Start work

1. `gh auth status`. If not signed in, tell the user to run `gh auth login`, then continue.
2. Find or open the issue (see `.claude/rules/github-issues.md`), assign it to `@me`, and re-read it to confirm no one else is on it.
3. Cut a worktree and branch from the latest main:
   `git -C <root>/eido fetch -q origin main && git -C <root>/eido worktree add <root>/eido-worktrees/<slug> -b <type>/<slug> origin/main`
   Branch types match conventional commits: `feat`, `fix`, `chore`, `docs`, `ci`. Work only inside that worktree.
4. `pnpm install --frozen-lockfile` in the new worktree.

## 2. Save and submit

1. `pnpm verify`. Fix failures before committing, unless the user only wants a draft.
2. Commit with a conventional message (`scope: imperative summary`). Stage specific files, never secrets. No AI attribution or model names.
3. `git fetch -q origin main`, then `git merge --no-edit origin/main`. Conflicts: resolve the obvious ones yourself; for a real choice, explain both sides in plain words and ask.
4. Push: `git push -u origin HEAD`. If SSH fails, use `git -c credential.helper= -c "credential.helper=!gh auth git-credential" push -q https://github.com/mgwedd/eido.git HEAD:<branch>`.
5. Open the PR: `gh pr create --repo mgwedd/eido --title "<conventional title>" --body-file <file>` with the issue's acceptance criteria and `Closes #N`. No attribution footer.

## 3. Get CI green

Stop only when CI is green, not when the PR opens.

1. `gh pr checks --watch` (or poll `gh pr checks`) until finished.
2. On a failure: `gh run view <run-id> --log-failed`, find the cause, fix it in the worktree, run the same check locally, commit, push. Repeat.
3. Common causes: `pnpm format:check` (run `pnpm exec prettier --write .`), lint, typecheck, a dependency boundary or gate-allowlist failure (never weaken a boundary or the allowlist to pass; fix the import or say so in the PR), a non-exact version (`pnpm turbo run //#check:versions`).
4. If the same check fails after three honest attempts, stop and tell the user what you tried and what you think is wrong.
5. When green, say so and give the PR link. Stop. The user or Michael merges; do not merge.

## 4. After the merge

When the user says it merged: `git -C <root>/eido worktree remove <root>/eido-worktrees/<slug>` and delete the local branch.

## Never

- Push to `main`, force-push, or rebase.
- Bare `git stash` (the stack is shared across worktrees): use a WIP commit.
- `git reset --hard` or delete files you did not create, without saying what will be lost.
- Edit the main checkout.
- Merge a PR.
- Add `pull_request_target` workflows or third-party actions to make CI pass.

## Recovery

- Edited in the wrong place or branch: copy the changes over, then tell the user in one line.
- Lost track of the state: `git status`, `git log --oneline -5`, `gh pr list --author @me`, then say plainly where things stand.
