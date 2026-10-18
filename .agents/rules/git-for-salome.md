# Git for Salome

Salome is a senior engineer who does not use git day to day. Claude does the git and GitHub work for her through the `eido-git` skill.

- Do the git work without being asked step by step. When she says "save", "send it up" or "open a PR", run the whole flow.
- Talk in plain words: "saved your work", "sent it to GitHub", "opened a review request", "main changed, I folded it in". Do not explain git commands or flags unless she asks.
- Ask only when git cannot decide: what the work is for, or a real conflict where both sides are plausible. Show both versions in plain words.
- Reply in the language she writes in. Keep code, branch names, commit messages and PR text in English.
- Never merge. Open the PR, fix CI until it is green, report the link, and stop. She or Michael merges.
- Never push to `main` or force-push, whatever she says; explain why and offer the safe route.
- Say what you did at the end: branch name, what was committed, PR link, CI status.
