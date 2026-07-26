#!/usr/bin/env bash
#
# Deploy this repo to the wall mirror.
#
# The previous version of this script rsynced two individual files and never
# shipped lib/, so every backend change -- polling, packages, Google Voice,
# contacts -- stayed on the laptop while the mirror kept running old code. It
# also rewrote the mirror's config with sed on every run and restarted lightdm,
# tearing down the whole X session. Both are gone.
#
# Usage:
#   scripts/deploy.sh                 deploy modules + config
#   scripts/deploy.sh --modules-only  leave config/config.js and custom.css alone
#   scripts/deploy.sh --dry-run       show what would transfer, change nothing
#
set -euo pipefail

REMOTE="${SECONDBRAIN_REMOTE:-jake@192.168.1.10}"
MM_ROOT="/opt/MagicMirror"
STATE_DIR="/var/lib/magicmirror-secondbrain"
SERVICE_USER="calendar-display"
KIOSK_HOME="/home/${SERVICE_USER}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

MODULES_ONLY=0
DRY_RUN=""

for arg in "$@"; do
  case "$arg" in
    --modules-only) MODULES_ONLY=1 ;;
    --dry-run)      DRY_RUN="--dry-run" ;;
    -h|--help)      sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

# ---------------------------------------------------------------------------
# Refuse to ship code that does not parse. A syntax error here means a blank
# wall until somebody notices it.
# ---------------------------------------------------------------------------
say "Checking syntax"
while IFS= read -r file; do
  node --check "$file" >/dev/null || { echo "Syntax error in $file" >&2; exit 1; }
done < <(find modules config -name '*.js' -not -path '*/node_modules/*')
echo "    all files parse"

say "Running package parser checks"
node scripts/check-packages.js >/dev/null || {
  echo "Package checks failed. Run 'node scripts/check-packages.js' to see why." >&2
  exit 1
}
echo "    checks pass"

say "Checking connectivity to ${REMOTE}"
if ! ssh -o BatchMode=yes -o ConnectTimeout=8 "$REMOTE" true 2>/dev/null; then
  echo "Cannot reach ${REMOTE} over SSH." >&2
  echo "Set SECONDBRAIN_REMOTE if the mirror moved, or check that it is powered on." >&2
  exit 1
fi
echo "    reachable"

STAGE="/tmp/secondbrain-deploy-$$"
ssh "$REMOTE" "rm -rf '$STAGE' && mkdir -p '$STAGE/modules'"
# shellcheck disable=SC2064
trap "ssh '$REMOTE' \"rm -rf '$STAGE'\" >/dev/null 2>&1 || true" EXIT

# ---------------------------------------------------------------------------
# Whole directories, so lib/ and tools/ actually travel with the module.
# node_modules is installed on the mirror rather than copied across.
# ---------------------------------------------------------------------------
say "Transferring modules"
rsync -az $DRY_RUN --delete \
  --exclude 'node_modules' \
  --exclude '__pycache__' \
  modules/MMM-SecondBrain \
  modules/MMM-SolarTheme \
  modules/MMM-CalendarLiveHeader \
  "$REMOTE:$STAGE/modules/"

say "Transferring system files"
rsync -az $DRY_RUN clock/magicmirror-python-clock.py "$REMOTE:$STAGE/"
rsync -az $DRY_RUN system/openbox/autostart "$REMOTE:$STAGE/openbox-autostart"

if [ "$MODULES_ONLY" -eq 0 ]; then
  say "Transferring config"
  rsync -az $DRY_RUN config/config.js "$REMOTE:$STAGE/config.js"
  if [ -f config/custom.css ]; then
    rsync -az $DRY_RUN config/custom.css "$REMOTE:$STAGE/custom.css"
  else
    echo "    config/custom.css is absent from the repo; leaving the mirror's copy alone."
    echo "    Run scripts/pull-from-pi.sh to bring it under version control."
  fi
else
  echo "    --modules-only: config untouched"
fi

if [ -n "$DRY_RUN" ]; then
  say "Dry run complete. Nothing on the mirror was changed."
  exit 0
fi

# ---------------------------------------------------------------------------
# Install. Ownership matches the service user so the module can write its own
# state -- the reason package tracking never persisted before.
# ---------------------------------------------------------------------------
say "Installing on the mirror"
ssh -t "$REMOTE" "set -euo pipefail

  echo '--> modules'
  for m in MMM-SecondBrain MMM-SolarTheme MMM-CalendarLiveHeader; do
    sudo mkdir -p '$MM_ROOT/modules/'\$m
    sudo rsync -a --delete --exclude node_modules \
      '$STAGE/modules/'\$m/ '$MM_ROOT/modules/'\$m/
    sudo chown -R ${SERVICE_USER}:${SERVICE_USER} '$MM_ROOT/modules/'\$m
  done

  echo '--> dependencies'
  cd '$MM_ROOT/modules/MMM-SecondBrain'
  sudo -u ${SERVICE_USER} npm ci --omit=dev --no-audit --no-fund

  echo '--> state directory'
  sudo mkdir -p '$STATE_DIR'
  sudo chown ${SERVICE_USER}:${SERVICE_USER} '$STATE_DIR'
  sudo chmod 700 '$STATE_DIR'

  if [ -f '$STAGE/config.js' ]; then
    echo '--> config.js'
    [ -f '$MM_ROOT/config/config.js' ] && \
      sudo cp '$MM_ROOT/config/config.js' '$MM_ROOT/config/config.js.bak'
    sudo install -o ${SERVICE_USER} -g ${SERVICE_USER} -m 644 \
      '$STAGE/config.js' '$MM_ROOT/config/config.js'
  fi

  if [ -f '$STAGE/custom.css' ]; then
    echo '--> custom.css'
    [ -f '$MM_ROOT/config/custom.css' ] && \
      sudo cp '$MM_ROOT/config/custom.css' '$MM_ROOT/config/custom.css.bak'
    sudo install -o ${SERVICE_USER} -g ${SERVICE_USER} -m 644 \
      '$STAGE/custom.css' '$MM_ROOT/config/custom.css'
  fi

  echo '--> clock'
  sudo install -o root -g root -m 755 \
    '$STAGE/magicmirror-python-clock.py' /usr/local/bin/magicmirror-python-clock.py

  echo '--> openbox autostart'
  sudo mkdir -p '$KIOSK_HOME/.config/openbox'
  sudo install -o ${SERVICE_USER} -g ${SERVICE_USER} -m 755 \
    '$STAGE/openbox-autostart' '$KIOSK_HOME/.config/openbox/autostart'

  rm -rf '$STAGE'

  echo '--> restarting magicmirror'
  sudo systemctl restart magicmirror
"

# ---------------------------------------------------------------------------
# A restarted unit is not a working one. Wait, then read the log back.
# ---------------------------------------------------------------------------
say "Verifying"
sleep 12

ssh "$REMOTE" "
  if ! systemctl is-active --quiet magicmirror; then
    echo 'magicmirror is not running:'
    sudo journalctl -u magicmirror -n 40 --no-pager
    exit 1
  fi
  echo '    service is active'

  echo
  echo '    recent SecondBrain output:'
  sudo journalctl -u magicmirror --since '2 minutes ago' --no-pager \
    | grep -i 'secondbrain' | tail -15 || echo '    (nothing logged yet)'
"

say "Deployed"
cat <<EOF

The X session was left alone; only the magicmirror service restarted. If the
display looks wrong, the previous config is at:
  ${MM_ROOT}/config/config.js.bak
  ${MM_ROOT}/config/custom.css.bak

Watch it live with:
  ssh ${REMOTE} "sudo journalctl -u magicmirror -f | grep -i secondbrain"
EOF
