# Git workflow

- `main` is the baseline. PRs are squash-merged into it. Merge, never rebase, never force-push.
- Every task runs in its own worktree under `/Users/wedd/dev/eido-worktrees/<slug>`, on a branch cut from `origin/main`: `cd /Users/wedd/dev/eido && git fetch -q origin main && git worktree add /Users/wedd/dev/eido-worktrees/<slug> -b <branch> origin/main`. Salome's machine uses the equivalent paths on Windows; the layout is a sibling `eido-worktrees/` directory next to the main checkout.
- The main checkout stays on `main`. Never switch or detach it.
- A new worktree has no `node_modules`: run `pnpm install --frozen-lockfile` in it (the pnpm store is shared, so this is fast).
- Parallel tasks never edit the same files. Split file ownership up front.
- Staying current: the `sync-main.sh` hook (`.claude/hooks/sync-main.sh`, wired in `.claude/settings.json`) fetches at session start and at most every two minutes per prompt. It fast-forwards `main` when its checkout is clean, and reports when `origin/main` moved and whether a merge into your branch would be clean.
  - It reports a clean merge and your tree is clean: merge now with `git merge --no-edit origin/main`.
  - It reports conflicts: finish and commit your current edit, then merge and resolve.
  - Always merge the PR's base branch before opening the PR.
  - In app-made worktrees, `mcp__ccd_host__sync_with_base_branch` does the same.
- Pushing: if the SSH remote lacks keys (sandbox), push with `git -c credential.helper= -c "credential.helper=!gh auth git-credential" push -q https://github.com/mgwedd/eido.git HEAD:<branch>`.
- Push straight to `main` only when the user asks for it. Otherwise open a PR and let the user merge.
- Never run bare `git stash`: the stack is shared across worktrees. Prefer a WIP commit to set work aside. If you must stash, use `git stash push -u -m <tag>`, take the entry's SHA from `git stash list --format='%H %gs'`, restore with `git stash apply <sha>` (not pop), then drop the entry by its current `stash@{n}`, found by tag.
- After the PR merges: `git worktree remove <path>` and delete the branch.
