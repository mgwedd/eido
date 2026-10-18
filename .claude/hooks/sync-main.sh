#!/usr/bin/env bash
# sync-main.sh session|prompt
#
# Keeps local main current and tells the agent when origin/main moved.
# Runs as the SessionStart (session) and UserPromptSubmit (prompt) hook.
# Stdout is added to the agent's context, so only report lines go there.
# Never blocks: the body runs in a subshell and the script always exits 0.
#
# State:
#   last-fetch   the prompt throttle. In the common git dir, shared by every worktree.
#   last-main  the moved notice. In each worktree's own git dir (the main checkout's
#                is the common dir), so every worktree reports a move once.

main() {
  local mode="${1:-session}" common gitdir state wtstate now last cur old n behind path branch out rc files
  local -a fetch
  common=$(git rev-parse --path-format=absolute --git-common-dir) || return 0
  gitdir=$(git rev-parse --path-format=absolute --git-dir) || return 0
  state="$common/claude-sync"
  wtstate="$gitdir/claude-sync"
  mkdir -p "$state" "$wtstate" || return 0

  now=$(date +%s)
  if [ "$mode" = prompt ]; then
    last=$(cat "$state/last-fetch" 2>/dev/null)
    case "$last" in ''|*[!0-9]*) last=0 ;; esac
    [ $((now - last)) -lt 120 ] && return 0
  fi

  # Stamp every attempt, even a failed one, so an offline machine retries at most every 120s.
  printf '%s\n' "$now" > "$state/last-fetch"
  export GIT_TERMINAL_PROMPT=0
  fetch=(git fetch -q origin main)
  command -v timeout >/dev/null 2>&1 && fetch=(timeout 20 "${fetch[@]}")
  "${fetch[@]}" >/dev/null 2>&1 || { echo "sync-main: fetch failed (offline?)"; return 0; }

  cur=$(git rev-parse -q --verify refs/remotes/origin/main) || return 0

  old=$(cat "$wtstate/last-main" 2>/dev/null)
  if [ -n "$old" ] && [ "$old" != "$cur" ]; then
    n=$(git rev-list --count "$old..$cur" 2>/dev/null) || n="?"
    echo "origin/main moved since last check: $n new commit(s)"
    git log --oneline --no-decorate "$old..$cur" 2>/dev/null | head -15
  fi
  printf '%s\n' "$cur" > "$wtstate/last-main"

  # Fast-forward main in the checkout that has it, if that checkout is clean.
  behind=$(git rev-list --count refs/heads/main..origin/main 2>/dev/null) || behind=0
  if [ "$behind" -gt 0 ]; then
    path=$(git worktree list --porcelain | awk '/^worktree /{p=substr($0,10)} /^branch refs\/heads\/main$/{print p; exit}')
    if [ -z "$path" ]; then
      echo "main not updated: no worktree has main checked out"
    elif [ -n "$(git -C "$path" status --porcelain 2>/dev/null)" ]; then
      echo "main not updated: $path has uncommitted changes"
    elif ! git merge-base --is-ancestor refs/heads/main origin/main 2>/dev/null; then
      echo "main not updated: local main has commits that origin/main does not"
    elif git -C "$path" merge -q --ff-only origin/main >/dev/null 2>&1; then
      echo "main fast-forwarded to $(git rev-parse --short origin/main)"
    else
      echo "main not updated: fast-forward in $path failed"
    fi
  fi

  # On a task branch, report whether catching up with origin/main would merge cleanly.
  branch=$(git symbolic-ref -q --short HEAD) || return 0
  [ "$branch" = main ] && return 0
  behind=$(git rev-list --count HEAD..origin/main 2>/dev/null) || return 0
  [ "$behind" -gt 0 ] || return 0
  out=$(git merge-tree --write-tree --name-only --no-messages origin/main HEAD 2>/dev/null)
  rc=$?
  if [ "$rc" -eq 0 ]; then
    echo "branch $branch is $behind commit(s) behind origin/main; a merge would be clean: run git merge --no-edit origin/main when your tree is clean"
  elif [ "$rc" -eq 1 ]; then
    files=$(printf '%s\n' "$out" | tail -n +2 | paste -sd, - | sed 's/,/, /g')
    echo "branch $branch is $behind commit(s) behind origin/main; a merge would CONFLICT in: $files"
  fi
}

(main "$@") 2>/dev/null
exit 0
