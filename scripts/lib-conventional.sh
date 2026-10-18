#!/bin/bash
# Conventional Commits rules shared by scripts/compute-release.sh and
# scripts/changelog-section.sh, so the version bump and the changelog always
# agree on what a commit means. Sourced, never executed.
#
#   - A commit counts only when its subject is `type(scope)!: description` with
#     a known type (CC_KNOWN_TYPES). Anything else is ignored.
#   - Breaking means a `!` before the colon, or a `BREAKING CHANGE: ` or
#     `BREAKING-CHANGE: ` footer at the start of a body line. The footer match is
#     case-sensitive, and it counts for any known type.
#
# Commits are read with the full message (%B), one per \x1e record, via conventional_log.

CC_KNOWN_TYPES="feat fix perf refactor build chore revert docs style test ci"

# Prints the full message of every non-merge commit in RANGE, each followed by \x1e.
conventional_log() {
    git log "$1" --no-merges --pretty=format:'%B%x1e'
}

# Prints the latest v* tag, or nothing when no v* tag exists. Any other git
# failure is fatal, so it is never mistaken for "no tags".
conventional_last_tag() {
    if [ -z "$(git tag --list 'v*')" ]; then
        return 0
    fi
    git describe --tags --abbrev=0 --match 'v*'
}

# conventional_parse_message MESSAGE
# Sets CC_TYPE (lowercase), CC_BREAKING (1 or 0) and CC_DESC. Returns 1 when the
# message is not a conventional commit of a known type.
conventional_parse_message() {
    local message="$1" subject re type bang desc
    # git puts a newline before every record after the first; drop leading space.
    message="${message#"${message%%[![:space:]]*}"}"
    re='^([a-zA-Z]+)(\([^)]*\))?(!)?:[[:space:]]+(.*)$'
    subject="${message%%$'\n'*}"
    CC_TYPE="" CC_BREAKING=0 CC_DESC=""

    [[ $subject =~ $re ]] || return 1
    type="$(printf '%s' "${BASH_REMATCH[1]}" | tr '[:upper:]' '[:lower:]')"
    bang="${BASH_REMATCH[3]}"
    desc="${BASH_REMATCH[4]}"

    case " $CC_KNOWN_TYPES " in
        *" $type "*) ;;
        *) return 1 ;;
    esac

    CC_TYPE="$type"
    CC_DESC="$desc"
    if [ -n "$bang" ]; then
        CC_BREAKING=1
    fi
    if grep -Eq '^BREAKING[ -]CHANGE: ' <<<"$message"; then
        CC_BREAKING=1
    fi
    return 0
}

# conventional_bump MESSAGE -> prints major, minor, patch, or none.
conventional_bump() {
    if ! conventional_parse_message "$1"; then
        echo none
    elif [ "$CC_BREAKING" = 1 ]; then
        echo major
    elif [ "$CC_TYPE" = feat ]; then
        echo minor
    else
        case "$CC_TYPE" in
            fix|perf|revert) echo patch ;;
            *) echo none ;;
        esac
    fi
}

_cc_rank() {
    case "$1" in
        major) echo 3 ;;
        minor) echo 2 ;;
        patch) echo 1 ;;
        *) echo 0 ;;
    esac
}

# conventional_range_bump RANGE -> prints the highest bump across the commits in RANGE.
conventional_range_bump() {
    local best=none level message log
    log="$(conventional_log "$1")"
    while IFS= read -r -d $'\x1e' message; do
        level="$(conventional_bump "$message")"
        if [ "$(_cc_rank "$level")" -gt "$(_cc_rank "$best")" ]; then
            best="$level"
        fi
    done <<<"$log"
    echo "$best"
}
