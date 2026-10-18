#!/bin/bash
# Computes the next release version from Conventional Commits — the versioning
# brain of the automated release pipeline (.github/workflows/auto-release.yml).
#
# It looks at the commits since the last `v*` tag and decides the semver bump:
#   - a breaking change  (`feat!:`, `fix(x)!:`, or a `BREAKING CHANGE` footer) → major
#   - a `feat:`                                                               → minor
#   - a `fix:` / `perf:` / `revert:`                                          → patch
#   - only chore/docs/style/refactor/test/ci/build, or nothing releasable     → none
#
# A manual override (FORCE_BUMP=patch|minor|major) wins when there are commits
# to release. The very first run (no prior tag) releases the version already
# declared in the root package.json as-is, so the inaugural tag matches it.
#
# No third-party tools — just git and coreutils — so it adds nothing to the
# supply chain. Outputs `current`, `next`, `bump`, and `release` to stdout and,
# when running under Actions, appends them to $GITHUB_OUTPUT.
#
# Usage:
#   scripts/compute-release.sh                 # classify from git history
#   echo "feat: x" | scripts/compute-release.sh --classify   # print a bump for a
#                                                             # commit list (testing)

set -euo pipefail

# Classify a newline-separated list of commit subjects (optionally with bodies)
# read from stdin into a single bump level. Pure text in, one word out.
classify() {
    local log major=0 minor=0 patch=0
    log="$(cat)"

    # Breaking: a `!` before the colon on the type/scope, or a BREAKING CHANGE note.
    if printf '%s\n' "$log" | grep -Eiq '^[[:space:]]*(feat|fix|perf|refactor|build|chore|revert)(\([^)]*\))?!:' \
        || printf '%s\n' "$log" | grep -Eiq 'BREAKING[ -]CHANGE'; then
        major=1
    fi
    printf '%s\n' "$log" | grep -Eiq '^[[:space:]]*feat(\([^)]*\))?:' && minor=1
    printf '%s\n' "$log" | grep -Eiq '^[[:space:]]*(fix|perf|revert)(\([^)]*\))?:' && patch=1

    if [ "$major" = 1 ]; then echo "major"
    elif [ "$minor" = 1 ]; then echo "minor"
    elif [ "$patch" = 1 ]; then echo "patch"
    else echo "none"
    fi
}

if [ "${1:-}" = "--classify" ]; then
    classify
    exit 0
fi

# True when every changed path is documentation, markdown, or a test — i.e.
# nothing that affects the product. Only source or config changes should cut a
# release; a docs/test-only merge is not worth a rebuild. An empty list (no file
# changes) also counts as ignorable. Reads the newline-separated path list as $1.
only_ignorable_paths() {
    local files="$1" f
    [ -z "$(printf '%s' "$files" | tr -d '[:space:]')" ] && return 0
    while IFS= read -r f; do
        [ -z "$f" ] && continue
        case "$f" in
            *.md) ;;          # markdown (README, CHANGELOG, docs notes, …)
            docs/*) ;;        # the docs tree
            *.test.ts) ;;     # test sources
            fixtures/*) ;;    # boundary-check fixtures
            *) return 1 ;;    # a source or config file → releasable
        esac
    done <<EOF
$files
EOF
    return 0
}

if [ "${1:-}" = "--only-ignorable" ]; then
    # Testing hook: read a path list on stdin, exit 0 if all ignorable.
    only_ignorable_paths "$(cat)"
    exit $?
fi

cd "$(dirname "$0")/.."

PACKAGE_JSON="package.json"

# The version currently declared in the root package.json, normalized to X.Y.Z.
declared_version() {
    local v
    v="$(sed -nE 's/^[[:space:]]*"version":[[:space:]]*"([^"]+)".*/\1/p' "$PACKAGE_JSON" | head -n 1)"
    normalize "$v"
}

# Pad a version to three components: 1 -> 1.0.0, 1.2 -> 1.2.0.
normalize() {
    local v="${1#v}" major minor patch
    IFS=. read -r major minor patch <<EOF
$v
EOF
    echo "${major:-0}.${minor:-0}.${patch:-0}"
}

bump_version() {
    local version="$1" bump="$2" major minor patch
    IFS=. read -r major minor patch <<EOF
$(normalize "$version")
EOF
    case "$bump" in
        major) major=$((major + 1)); minor=0; patch=0 ;;
        minor) minor=$((minor + 1)); patch=0 ;;
        patch) patch=$((patch + 1)) ;;
    esac
    echo "${major}.${minor}.${patch}"
}

FORCE_BUMP="${FORCE_BUMP:-auto}"
LAST_TAG="$(git describe --tags --abbrev=0 --match 'v*' 2>/dev/null || true)"

if [ -z "$LAST_TAG" ]; then
    # First release: ship the version package.json already declares.
    CURRENT="0.0.0"
    NEXT="$(declared_version)"
    BUMP="initial"
    RELEASE="true"
else
    CURRENT="${LAST_TAG#v}"
    COMMITS="$(git log "${LAST_TAG}..HEAD" --pretty=format:'%s%n%b' 2>/dev/null || true)"
    COMMIT_COUNT="$(git rev-list "${LAST_TAG}..HEAD" --count 2>/dev/null || echo 0)"
    CHANGED="$(git diff --name-only "${LAST_TAG}..HEAD" 2>/dev/null || true)"

    if [ "$COMMIT_COUNT" -eq 0 ]; then
        BUMP="none"
    elif [ "$FORCE_BUMP" != "auto" ]; then
        BUMP="$FORCE_BUMP"
    else
        BUMP="$(printf '%s\n' "$COMMITS" | classify)"
    fi

    if [ "$BUMP" = "none" ]; then
        NEXT="$CURRENT"
        RELEASE="false"
    elif [ "$FORCE_BUMP" = "auto" ] && only_ignorable_paths "$CHANGED"; then
        # An automatic release, but only docs/tests/markdown changed since the
        # last tag — nothing that affects the product, so skip the rebuild.
        # A manual dispatch (FORCE_BUMP set) still releases regardless.
        NEXT="$CURRENT"
        BUMP="none"
        RELEASE="false"
    else
        NEXT="$(bump_version "$CURRENT" "$BUMP")"
        RELEASE="true"
    fi
fi

emit() {
    echo "$1"
    if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "$1" >> "$GITHUB_OUTPUT"; fi
}

emit "current=$CURRENT"
emit "next=$NEXT"
emit "bump=$BUMP"
emit "release=$RELEASE"
