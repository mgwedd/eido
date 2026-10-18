#!/bin/bash
# Generates the CHANGELOG.md section for a release from the Conventional Commits
# since the last v* tag. This is what lets CHANGELOG.md be produced in CI instead
# of hand-edited in every PR — hand-editing a shared [Unreleased] block was a
# constant source of merge conflicts.
#
# Classification is shared with compute-release.sh (scripts/lib-conventional.sh):
#   feat            → Added
#   fix, perf       → Fixed
#   revert          → Changed
#   any breaking commit (`type!:` or BREAKING CHANGE footer) → Changed, tagged (breaking)
#   chore/docs/test/ci/build/style/refactor → omitted (not user-facing)
#
# Pure git + bash. Prints the Markdown section to stdout.
#
# Usage: scripts/changelog-section.sh <version>

set -euo pipefail

VERSION="${1:?usage: changelog-section.sh <version>}"
VERSION="${VERSION#v}"
source "$(dirname "$0")/lib-conventional.sh"
cd "$(dirname "$0")/.."

TODAY="$(date -u +%Y-%m-%d)"
LAST_TAG="$(conventional_last_tag)"
RANGE="HEAD"
if [ -n "$LAST_TAG" ]; then
    RANGE="${LAST_TAG}..HEAD"
fi

added=""
fixed=""
changed=""

LOG="$(conventional_log "$RANGE")"
while IFS= read -r -d $'\x1e' message; do
    conventional_parse_message "$message" || continue
    if [ "$CC_BREAKING" = 1 ]; then
        changed+="- ${CC_DESC} (breaking)"$'\n'
        continue
    fi
    case "$CC_TYPE" in
        feat) added+="- ${CC_DESC}"$'\n' ;;
        fix|perf) fixed+="- ${CC_DESC}"$'\n' ;;
        revert) changed+="- ${CC_DESC}"$'\n' ;;
        *) : ;;
    esac
done <<<"$LOG"

out="## [${VERSION}] - ${TODAY}"$'\n'
[ -n "$added" ]   && out+=$'\n'"### Added"$'\n'"${added}"
[ -n "$fixed" ]   && out+=$'\n'"### Fixed"$'\n'"${fixed}"
[ -n "$changed" ] && out+=$'\n'"### Changed"$'\n'"${changed}"
if [ -z "${added}${fixed}${changed}" ]; then
    out+=$'\n'"- Maintenance and internal changes."$'\n'
fi

printf '%s' "$out"
