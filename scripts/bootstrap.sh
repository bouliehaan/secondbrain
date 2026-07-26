#!/usr/bin/env bash
#
# Install the third-party pieces this dashboard needs but does not vendor.
#
# Run once when rebuilding the mirror from scratch, or after bumping a pin in
# config/third-party-modules.json. Ordinary deploys do not need it.
#
# Usage:
#   scripts/bootstrap.sh              install missing modules on the mirror
#   scripts/bootstrap.sh --check      report what is installed, change nothing
#
set -euo pipefail

REMOTE="${SECONDBRAIN_REMOTE:-jake@192.168.1.10}"
MM_ROOT="/opt/MagicMirror"
SERVICE_USER="calendar-display"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1

say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

MANIFEST="config/third-party-modules.json"
[ -f "$MANIFEST" ] || { echo "Missing $MANIFEST" >&2; exit 1; }

say "Reading $MANIFEST"
node -e '
  const manifest = require("./config/third-party-modules.json");
  for (const m of manifest.modules) {
    console.log([m.name, m.repo, m.ref].join("\t"));
  }
' > /tmp/sb-modules.tsv

while IFS=$'\t' read -r name repo ref; do
  echo "    ${name} @ ${ref}"
done < /tmp/sb-modules.tsv

if node -e '
  const m = require("./config/third-party-modules.json");
  process.exit((m.unresolved || []).length > 0 ? 0 : 1);
'; then
  say "Unresolved dependencies"
  node -e '
    for (const u of require("./config/third-party-modules.json").unresolved) {
      console.log(`    ${u.name}\n      ${u.reason}\n`);
    }
  '
fi

say "Checking connectivity to ${REMOTE}"
ssh -o BatchMode=yes -o ConnectTimeout=8 "$REMOTE" true 2>/dev/null || {
  echo "Cannot reach ${REMOTE} over SSH." >&2
  exit 1
}
echo "    reachable"

say "Modules currently installed on the mirror"
ssh "$REMOTE" "ls -1 '$MM_ROOT/modules' 2>/dev/null | sed 's|^|    |'"

if [ "$CHECK_ONLY" -eq 1 ]; then
  say "Check only. Nothing was installed."
  exit 0
fi

say "Installing missing third-party modules"
while IFS=$'\t' read -r name repo ref; do
  ssh -t "$REMOTE" "set -eu
    target='$MM_ROOT/modules/$name'

    if [ -d \"\$target\" ]; then
      echo '    $name already present, leaving it alone'
      exit 0
    fi

    echo '--> cloning $name at $ref'
    sudo git clone --depth 1 --branch '$ref' '$repo' \"\$target\"
    sudo chown -R ${SERVICE_USER}:${SERVICE_USER} \"\$target\"

    if [ -f \"\$target/package.json\" ]; then
      cd \"\$target\"
      sudo -u ${SERVICE_USER} npm install --omit=dev --no-audit --no-fund
    fi
  "
done < /tmp/sb-modules.tsv

rm -f /tmp/sb-modules.tsv

say "Bootstrap complete"
echo "Now run scripts/deploy.sh to install this repo's own modules."
