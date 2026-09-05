#!/usr/bin/env bash
#
# commit.sh — gate the working tree, commit it, and get it onto GitHub.
#
#   ./scripts/commit.sh "what changed and why"
#   ./scripts/commit.sh --skip-gates "docs only"
#   ./scripts/commit.sh                  # no message: just push what is committed
#
# This does not cut releases. Tagging is its own decision: push a v* tag and the
# release workflow builds and publishes the .deb.
#
# The job is not finished when the commit object exists. It is finished when
# origin agrees, so this pushes and then re-checks the remote rather than
# trusting its own exit code.

set -euo pipefail

BRANCH="master"
SKIP_GATES=0

ARGS=()
for arg in "$@"; do
  case "$arg" in
    --skip-gates|-n) SKIP_GATES=1 ;;
    *) ARGS+=("$arg") ;;
  esac
done
MESSAGE="${ARGS[*]:-}"

# ---------------------------------------------------------------- preflight

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || {
  echo "Error: not inside a git repository." >&2; exit 1; }

# Run from the repo root whatever directory this was invoked from, so `git add`
# stages the whole repo and not just the subtree you happen to be in.
cd "$(git rev-parse --show-toplevel)"

CURRENT="$(git rev-parse --abbrev-ref HEAD)"
if [ "$CURRENT" != "$BRANCH" ]; then
  # Refusing is the point. `git add . && git commit` is perfectly happy to bury
  # an afternoon's work on a detached HEAD or a stray branch, and you would not
  # find out until the next time you looked for it.
  echo "Error: on '$CURRENT', expected '$BRANCH'." >&2
  echo "       git switch $BRANCH" >&2
  exit 1
fi

# --porcelain, NOT `git diff --quiet`: diff only sees files git already tracks,
# so a change made entirely of NEW files reads as "nothing to do".
DIRTY="$(git status --porcelain)"

HAVE_UPSTREAM=0
if git ls-remote --exit-code origin "$BRANCH" >/dev/null 2>&1; then
  HAVE_UPSTREAM=1
  git fetch --quiet origin "$BRANCH"
  AHEAD="$(git rev-list --count "origin/$BRANCH..HEAD")"
else
  echo "==> origin has no '$BRANCH' yet; this will be the first push."
  AHEAD=0
fi

if [ -z "$DIRTY" ] && [ "$AHEAD" -eq 0 ] && [ "$HAVE_UPSTREAM" -eq 1 ]; then
  echo "Nothing to do — tree is clean and origin/$BRANCH is up to date."
  exit 0
fi

if [ -n "$DIRTY" ] && [ -z "$MESSAGE" ]; then
  echo "Error: uncommitted changes need a message." >&2
  echo "       ./scripts/commit.sh \"what changed and why\"" >&2
  exit 1
fi

# ------------------------------------------------------------------ secrets
#
# The rule this repo keeps breaking: credentials and host-specific details never
# enter it. Both failures were silent and neither was noticed for weeks -- a
# deploy that shipped a redacted config.js took the private calendars off the
# wall for a week, and a redaction pass that ate a systemd unit name left an
# uninstallable unit behind. Checked here because this is the last point before
# anything is public.

echo "==> Checking for secrets"
LEAKS=0

# A specific host is a leak; a subnet is not. "192.168.1.0/24" in config.js is
# MagicMirror's ipWhitelist doing its job, so the address is only flagged when
# it is NOT followed by a "/" -- that is, when it names one machine rather than
# a range.
HOST_PATTERN='[A-Za-z0-9_.-]+@192\.168\.[0-9]+\.[0-9]+|192\.168\.[0-9]+\.[0-9]+([^/0-9]|$)|wg-quick@|[A-Za-z0-9-]+\.local\b'

# Real credential files. Only *.example.json belongs in the repo.
while IFS= read -r f; do
  case "$f" in
    *.example.json) ;;
    *) echo "  refusing: $f is a real credential file" >&2; LEAKS=1 ;;
  esac
done < <(git ls-files 'config/secondbrain/**/*.json' 'config/secondbrain/*.json')

# The two private calendar urls live only on the wall. If these markers are gone
# from config.js, the live urls are about to be committed in their place.
if [ -f config/config.js ]; then
  if [ "$(grep -c 'REDACTED_PRIVATE_PATH' config/config.js || true)" -lt 2 ]; then
    echo "  refusing: config/config.js is missing its REDACTED_PRIVATE_PATH markers" >&2
    echo "            the live Nextcloud/Jane urls must not be committed" >&2
    LEAKS=1
  fi
fi

# Host-specific details that have no business in a public repo. Tracked files
# only, so the untracked maintainer scripts that legitimately hold them are not
# flagged.
if git grep -nE "$HOST_PATTERN" -- \
     ':!*.example.json' ':!scripts/commit.sh' >/dev/null 2>&1; then
  echo "  warning: a tracked file names a private address or host unit:" >&2
  git grep -nE "$HOST_PATTERN" -- \
     ':!*.example.json' ':!scripts/commit.sh' | sed 's/^/            /' >&2
  echo "            remove it, or add it to the allowlist in this script." >&2
  LEAKS=1
fi

if [ "$LEAKS" -ne 0 ]; then
  echo >&2
  echo "Nothing was committed." >&2
  exit 1
fi
echo "    clean"

# -------------------------------------------------------------------- gates

if [ "$SKIP_GATES" -eq 0 ]; then
  echo "==> Running checks"
  make check-all
else
  echo "==> Gates SKIPPED (--skip-gates)"
fi

# ------------------------------------------------------------------- commit

if [ -n "$DIRTY" ]; then
  echo "==> Changes:"
  git status --short

  git add -A
  git commit -m "$MESSAGE"
fi

# --------------------------------------------------------------------- push

if [ "$HAVE_UPSTREAM" -eq 1 ]; then
  # Fetch again — the gates may have taken a minute, and a push rejected for
  # being behind is the most common way this ends in a mess.
  git fetch --quiet origin "$BRANCH"

  if [ "$(git rev-list --count "HEAD..origin/$BRANCH")" -gt 0 ]; then
    echo "==> origin/$BRANCH moved; rebasing onto it..."
    # Stops here on conflict, which is correct: that needs a human, and it
    # should not be resolved by a script holding a commit.
    git pull --rebase origin "$BRANCH"

    if [ "$SKIP_GATES" -eq 0 ]; then
      echo "==> Re-running checks after rebase..."
      make check-all
    fi
  fi

  echo "==> Pushing to origin/$BRANCH..."
  git push origin "$BRANCH"
else
  echo "==> Pushing to origin/$BRANCH for the first time..."
  git push -u origin "$BRANCH"
fi

# ------------------------------------------------------------------- verify

git fetch --quiet origin "$BRANCH"
read -r BEHIND STILL_AHEAD <<<"$(git rev-list --left-right --count "origin/$BRANCH...HEAD")"

if [ "$BEHIND" -eq 0 ] && [ "$STILL_AHEAD" -eq 0 ] && [ -z "$(git status --porcelain)" ]; then
  echo "==> Done. origin/$BRANCH == $(git rev-parse --short HEAD), tree clean."
else
  echo "Error: still out of sync (behind $BEHIND, ahead $STILL_AHEAD)." >&2
  exit 1
fi
