#!/usr/bin/env bash
# verify.sh  (PostToolUse hook for Edit|Write|MultiEdit)
#
# Fast per-file check after Claude edits a source file. Catches bad imports, type errors,
# lint errors and references to deleted exports without running `pnpm verify`.
#   .ts/.tsx/.mts/.cts/.js/.jsx/.mjs/.cjs: eslint on that file, run from its package
#       (the repo's own config), plus the package's own `typecheck` script when it is a
#       plain `tsc ...` command (incremental, about 2s warm; whole package, so a deleted
#       export that another file still imports shows up too).
#   .rs: rustfmt --check on that file, from the file-helper crate.
# Silent and exit 0 on success, on skipped files and on missing tools or timeouts.
# On failure: first 20 lines per check on stderr, exit 2 (Claude Code feeds that back to the model).
# Needs jq. Reads the hook JSON on stdin (tool_input.file_path).

command -v jq >/dev/null 2>&1 || exit 0
file=$(jq -r '.tool_input.file_path // empty' 2>/dev/null) || exit 0
[ -n "$file" ] || exit 0

case "$file" in
  *.ts|*.tsx|*.mts|*.cts|*.js|*.jsx|*.mjs|*.cjs) kind=ts ;;
  *.rs) kind=rs ;;
  *) exit 0 ;;
esac
case "$file" in
  */node_modules/*|*/dist/*|*/.next/*|*/coverage/*|*/.turbo/*|*/target/*|*/src/generated/*) exit 0 ;;
esac
[ -f "$file" ] || exit 0

root=${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}
root=$(cd "$root" 2>/dev/null && pwd -P) || exit 0
dir=$(cd "$(dirname "$file")" 2>/dev/null && pwd -P) || exit 0
abs="$dir/$(basename "$file")"
case "$abs" in "$root"/*) ;; *) exit 0 ;; esac

# Timeout guard: each check gets a hard cap; a timeout is treated as "skipped", never as a failure.
limit=12
to=()
if command -v timeout >/dev/null 2>&1; then to=(timeout "$limit")
elif command -v gtimeout >/dev/null 2>&1; then to=(gtimeout "$limit"); fi

out=$(mktemp -d "${TMPDIR:-/tmp}/verify-hook.XXXXXX") || exit 0
trap 'rm -rf "$out"' EXIT

fail=0
report() { # report <label> <file>
  echo "verify: $1 failed for ${abs#"$root"/}" >&2
  head -n 20 "$2" >&2
  fail=1
}

if [ "$kind" = rs ]; then
  command -v rustfmt >/dev/null 2>&1 || { echo "verify: rustfmt not installed, skipped" >&2; exit 0; }
  crate="$root/packages/gate/native/file-helper"
  case "$abs" in "$crate"/*) cd "$crate" || exit 0 ;; *) cd "$dir" || exit 0 ;; esac
  edition=$(sed -n 's/^edition *= *"\([0-9]*\)".*/\1/p' "$crate/Cargo.toml" 2>/dev/null | head -n1)
  "${to[@]}" rustfmt --check --color never --edition "${edition:-2021}" "$abs" >"$out/rs" 2>&1
  [ $? -eq 1 ] && report "rustfmt --check" "$out/rs"
  [ $fail -eq 0 ] && exit 0 || exit 2
fi

# Nearest package (a package.json below the repo root) owns the lint and typecheck config.
pkg=$dir
while [ "$pkg" != "$root" ] && [ ! -f "$pkg/package.json" ]; do pkg=$(dirname "$pkg"); done
[ "$pkg" != "$root" ] || exit 0
command -v pnpm >/dev/null 2>&1 || { echo "verify: pnpm not installed, skipped" >&2; exit 0; }
[ -d "$pkg/node_modules" ] || { echo "verify: dependencies not installed in ${pkg#"$root"/}, skipped" >&2; exit 0; }
cd "$pkg" || exit 0

# Lint just this file with the package's eslint config.
lint_pid=
if ls eslint.config.* >/dev/null 2>&1 && [ -x node_modules/.bin/eslint ]; then
  ( "${to[@]}" pnpm exec eslint --no-warn-ignored "$abs" >"$out/lint" 2>&1; echo $? >"$out/lint.rc" ) &
  lint_pid=$!
fi

# Typecheck with the package's own script when it is a plain tsc command (TS files only).
tc_pid=
case "$abs" in *.js|*.jsx|*.mjs|*.cjs) ;; *)
  tc=$(jq -r '.scripts.typecheck // empty' package.json 2>/dev/null)
  case "$tc" in
    tsc|tsc\ *)
      # A plain `tsc --noEmit` (apps/web) reads the declaration output of referenced projects,
      # so build those first (incremental, cached); otherwise every import of them fails.
      case "$tc" in *" -b"*) refs= ;; *) refs=$(jq -r '.references[]?.path' tsconfig.json 2>/dev/null) ;; esac
      ( [ -n "$refs" ] && "${to[@]}" pnpm exec tsc -b $refs >/dev/null 2>&1
        "${to[@]}" pnpm exec $tc >"$out/tc" 2>&1; echo $? >"$out/tc.rc" ) & tc_pid=$! ;;
  esac ;;
esac

[ -n "$lint_pid" ] && wait "$lint_pid"
[ -n "$tc_pid" ] && wait "$tc_pid"

if [ -f "$out/lint.rc" ] && [ "$(cat "$out/lint.rc")" = 1 ]; then report "eslint" "$out/lint"; fi
if [ -f "$out/tc.rc" ] && [ "$(cat "$out/tc.rc")" != 0 ] && [ "$(cat "$out/tc.rc")" != 124 ]; then
  # TS6305 means a referenced project is not built yet (turbo builds it first); it is not an error in the edit.
  grep -v 'error TS6305' "$out/tc" >"$out/tc.f"
  if grep -q 'error TS' "$out/tc.f"; then report "typecheck" "$out/tc.f"; fi
fi
[ $fail -eq 0 ] && exit 0 || exit 2
