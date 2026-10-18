#!/bin/bash
# Applies a computed release version to the repo, ready to commit and tag.
# Called by .github/workflows/auto-release.yml after compute-release.sh.
#
#   1. Sets the root package.json "version" to the new version.
#   2. Inserts a CHANGELOG.md section for the version, generated from the
#      Conventional Commits since the last tag (see changelog-section.sh).
#      Skipped when a "## [<version>]" section already exists, so re-running
#      for the same version never duplicates it.
#      CHANGELOG.md is never hand-edited in PRs, so it can't cause conflicts.
#
# Pure awk + git — no third-party tools.
#
# Usage: scripts/apply-release.sh <version>   e.g. scripts/apply-release.sh 1.1.0

set -euo pipefail

VERSION="${1:?usage: apply-release.sh <version>}"
VERSION="${VERSION#v}"
cd "$(dirname "$0")/.."

PACKAGE_JSON="package.json"
CHANGELOG="CHANGELOG.md"

# --- package.json: set the first top-level "version" field. Setting the same
# value twice is a no-op. ---
tmp="$(mktemp)"
awk -v value="$VERSION" '
    !done && /^[[:space:]]*"version":/ {
        sub(/"version":[[:space:]]*"[^"]*"/, "\"version\": \"" value "\"")
        done = 1
    }
    { print }
' "$PACKAGE_JSON" > "$tmp"
mv "$tmp" "$PACKAGE_JSON"

# --- CHANGELOG: insert this version's section above the most recent existing
# version (right after the header block), unless it is already there. ---
if grep -qF "## [${VERSION}]" "$CHANGELOG"; then
    echo "CHANGELOG.md already has a [${VERSION}] section; leaving it unchanged."
else
    SECTION="$(scripts/changelog-section.sh "$VERSION")"
    tmp="$(mktemp)"
    SECTION="$SECTION" awk '
        !done && /^## \[/ {
            print ENVIRON["SECTION"]
            print ""
            done = 1
        }
        { print }
        END { if (!done) { print ""; print ENVIRON["SECTION"] } }
    ' "$CHANGELOG" > "$tmp"
    mv "$tmp" "$CHANGELOG"
fi

echo "Applied version $VERSION to package.json and CHANGELOG.md."
