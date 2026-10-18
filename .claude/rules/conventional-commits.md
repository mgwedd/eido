# Conventional Commits

- Commit messages and PR titles are Conventional Commits: `type(scope)!: subject`, with type one of feat, fix, perf, revert, docs, style, refactor, test, build, ci, chore. The scope is optional.
- PRs are squash-merged, so the PR title becomes the commit on `main`. `.github/workflows/commitlint.yml` rejects a PR whose title does not match.
- Never mark a change breaking (`!` or `BREAKING CHANGE`) on your own judgement; only when the user asks.
- Commit as the maintainer. No AI attribution in commits, PRs or issues, and no model identifiers in anything pushed.
