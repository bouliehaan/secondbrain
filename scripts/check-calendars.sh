#!/usr/bin/env bash
#
# Ask the mirror whether its calendar is actually syncing.
#
# Needs no sudo and changes nothing. Run it when the wall looks stale, and after
# every deploy -- deploy.sh runs it too.
#
# Usage:
#   scripts/check-calendars.sh              urls masked
#   scripts/check-calendars.sh --show-urls  print the private calendar urls
#
set -euo pipefail

REMOTE="${SECONDBRAIN_REMOTE:-jake@192.168.1.10}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! ssh -o BatchMode=yes -o ConnectTimeout=8 "$REMOTE" true 2>/dev/null; then
  echo "Cannot reach ${REMOTE} over SSH." >&2
  echo "Set SECONDBRAIN_REMOTE if the mirror moved, or check that it is powered on." >&2
  exit 1
fi

# Piped to node's stdin so there is nothing to copy over and nothing to clean up.
ssh "$REMOTE" "node - ${*:-}" < "$REPO_ROOT/scripts/check-calendars.js"
