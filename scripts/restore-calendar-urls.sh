#!/usr/bin/env bash
#
# Put the private calendar urls back into the mirror's live config, then reload
# the wall.
#
# Needed once, after a deploy shipped the repo's redacted config.js over the
# real one. The urls are recovered from the journal -- see
# restore-calendar-urls.js -- and never leave the mirror.
#
# Uses sudo on the mirror, so run it yourself; it will prompt.
#
# Usage:
#   scripts/restore-calendar-urls.sh            repair, install, reload
#   scripts/restore-calendar-urls.sh --dry-run  show what it would restore
#
set -euo pipefail

REMOTE="${SECONDBRAIN_REMOTE:-jake@192.168.1.10}"
MM_ROOT="/opt/MagicMirror"
SERVICE_USER="calendar-display"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

if ! ssh -o BatchMode=yes -o ConnectTimeout=8 "$REMOTE" true 2>/dev/null; then
  echo "Cannot reach ${REMOTE} over SSH." >&2
  exit 1
fi

# The repaired config is written on the mirror, never on this machine, so the
# calendar tokens stay where they belong.
say "Recovering the private calendar urls from the journal"
ssh "$REMOTE" "umask 077 && node - > /tmp/config.restored.js" \
  < "$REPO_ROOT/scripts/restore-calendar-urls.js"

if [ "$DRY_RUN" -eq 1 ]; then
  say "Dry run: what would be installed"
  ssh "$REMOTE" "
    grep -n 'url:' /tmp/config.restored.js | sed -E 's#(://[^/]+/)[^\"]*#\1…#'
    rm -f /tmp/config.restored.js
  "
  say "Nothing was changed."
  exit 0
fi

say "Installing it and reloading the wall"
ssh -t "$REMOTE" "set -euo pipefail

  sudo cp '$MM_ROOT/config/config.js' '$MM_ROOT/config/config.js.redacted.bak'
  sudo install -o ${SERVICE_USER} -g ${SERVICE_USER} -m 644 \
    /tmp/config.restored.js '$MM_ROOT/config/config.js'
  rm -f /tmp/config.restored.js

  sudo systemctl restart magicmirror

  # Fetchers are registered by the page, not the server, so the browser has to
  # come back too. calendar-kiosk relaunches it.
  sudo pkill -u ${SERVICE_USER} -f magicmirror-kiosk || true
"

say "Checking that events actually fetch"
sleep 25
"$REPO_ROOT/scripts/check-calendars.sh"

cat <<EOF

Keep a copy of the repaired config somewhere backed up -- the journal is the
only other place those urls exist, and it rotates:

  ssh ${REMOTE} "cat ${MM_ROOT}/config/config.js" > ~/secondbrain-config-with-urls.js

The redacted one it replaced is at ${MM_ROOT}/config/config.js.redacted.bak
EOF
