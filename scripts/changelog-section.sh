#!/bin/bash
# Generates the CHANGELOG.md section for a release from the Conventional Commit
# subjects since the last v* tag. This is what lets CHANGELOG.md be produced in
# CI instead of hand-edited in every PR — hand-editing a shared [Unreleased]
# block was a constant source of merge conflicts.
#
# Grouping (Keep a Changelog):
#   feat            → Added
#   fix, perf       → Fixed
#   revert          → Changed
#   any `type!:` or BREAKING CHANGE → Changed, tagged (breaking)
#   chore/docs/test/ci/build/style/refactor → omitted (not user-facing)
#
# Pure git + bash. Prints the Markdown section to stdout.
#
# Usage: scripts/changelog-section.sh <version>

set -euo pipefail

VERSION="${1:?usage: changelog-section.sh <version>}"
VERSION="${VERSION#v}"
cd "$(dirname "$0")/.."

TODAY="$(date -u +%Y-%m-%d)"
LAST_TAG="$(git describe --tags --abbrev=0 --match 'v*' 2>/dev/null || true)"
RANGE="HEAD"
[ -n "$LAST_TAG" ] && RANGE="${LAST_TAG}..HEAD"

# %s = subject, then %b = body, separated so a BREAKING CHANGE footer counts.
LOG="$(git log $RANGE --no-merges --pretty=format:'%s')"

added=""
fixed=""
changed=""

while IFS= read -r subject; do
    [ -z "$subject" ] && continue
    if [[ "$subject" =~ ^([a-zA-Z]+)(\([^\)]*\))?(!)?:[[:space:]]+(.*)$ ]]; then
        type="$(printf '%s' "${BASH_REMATCH[1]}" | tr '[:upper:]' '[:lower:]')"
        bang="${BASH_REMATCH[3]}"
        desc="${BASH_REMATCH[4]}"
        if [ -n "$bang" ]; then
            changed+="- ${desc} (breaking)"$'\n'
            continue
        fi
        case "$type" in
            feat) added+="- ${desc}"$'\n' ;;
            fix|perf) fixed+="- ${desc}"$'\n' ;;
            revert) changed+="- ${desc}"$'\n' ;;
            *) : ;;
        esac
    fi
done <<EOF
$LOG
EOF

out="## [${VERSION}] - ${TODAY}"$'\n'
[ -n "$added" ]   && out+=$'\n'"### Added"$'\n'"${added}"
[ -n "$fixed" ]   && out+=$'\n'"### Fixed"$'\n'"${fixed}"
[ -n "$changed" ] && out+=$'\n'"### Changed"$'\n'"${changed}"
if [ -z "${added}${fixed}${changed}" ]; then
    out+=$'\n'"- Maintenance and internal changes."$'\n'
fi

printf '%s' "$out"
