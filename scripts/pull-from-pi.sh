#!/usr/bin/env bash
#
# Pull the mirror's live state back into this repo.
#
# Some things only ever existed on the mirror -- custom.css above all, roughly
# 1800 lines that style the entire dashboard and were never committed here.
# Until this has been run at least once, the mirror is the source of truth for
# those files and deploy.sh deliberately refuses to overwrite them.
#
# Secrets are never copied. /etc/magicmirror-secondbrain stays on the mirror;
# this only reports which account files exist there so the *.example.json
# templates in config/secondbrain/ can be kept honest.
#
# Usage:
#   scripts/pull-from-pi.sh          pull, then show a diff summary
#   scripts/pull-from-pi.sh --diff   show what would change, write nothing
#
set -euo pipefail

REMOTE="${SECONDBRAIN_REMOTE:-jake@192.168.1.10}"
MM_ROOT="/opt/MagicMirror"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

DIFF_ONLY=0
[ "${1:-}" = "--diff" ] && DIFF_ONLY=1

say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

say "Checking connectivity to ${REMOTE}"
if ! ssh -o BatchMode=yes -o ConnectTimeout=8 "$REMOTE" true 2>/dev/null; then
  echo "Cannot reach ${REMOTE} over SSH." >&2
  exit 1
fi
echo "    reachable"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

# ---------------------------------------------------------------------------
# Stage on the mirror first. Several of these are root-owned, so they are copied
# somewhere readable before rsync pulls them.
# ---------------------------------------------------------------------------
say "Collecting live files"
REMOTE_STAGE="/tmp/secondbrain-pull-$$"
ssh "$REMOTE" "set -eu
  rm -rf '$REMOTE_STAGE'
  mkdir -p '$REMOTE_STAGE/config' '$REMOTE_STAGE/modules'

  for f in config.js custom.css; do
    [ -f '$MM_ROOT/config/'\$f ] && sudo cp '$MM_ROOT/config/'\$f '$REMOTE_STAGE/config/'\$f
  done

  for m in MMM-SecondBrain MMM-SolarTheme MMM-CalendarLiveHeader MMT-CalmCurrentWeather; do
    if [ -d '$MM_ROOT/modules/'\$m ]; then
      sudo cp -r '$MM_ROOT/modules/'\$m '$REMOTE_STAGE/modules/'\$m
      sudo rm -rf '$REMOTE_STAGE/modules/'\$m/node_modules
    fi
  done

  sudo chown -R \$(id -un):\$(id -gn) '$REMOTE_STAGE'

  # Report the shape of the secret store without revealing any of it.
  echo '--- account files on the mirror ---' > '$REMOTE_STAGE/secrets-inventory.txt'
  sudo find /etc/magicmirror-secondbrain -name '*.json' 2>/dev/null \
    | sed 's|^|  |' >> '$REMOTE_STAGE/secrets-inventory.txt' || true
"

rsync -az "$REMOTE:$REMOTE_STAGE/" "$STAGE/"
ssh "$REMOTE" "rm -rf '$REMOTE_STAGE'"
echo "    collected"

say "Secret store on the mirror (names only, no values)"
cat "$STAGE/secrets-inventory.txt" 2>/dev/null || echo "  (none found)"

# ---------------------------------------------------------------------------
compare() {
  local live="$1" repo="$2"
  [ -f "$live" ] || return 0

  if [ ! -f "$repo" ]; then
    echo "  NEW      $repo"
    return 0
  fi

  if diff -q "$live" "$repo" >/dev/null 2>&1; then
    echo "  same     $repo"
  else
    local added removed
    added=$(diff "$repo" "$live" | grep -c '^>' || true)
    removed=$(diff "$repo" "$live" | grep -c '^<' || true)
    echo "  DIFFERS  $repo  (+${added} -${removed} vs mirror)"
  fi
}

say "Comparing mirror against repo"
compare "$STAGE/config/config.js"  "config/config.js"
compare "$STAGE/config/custom.css" "config/custom.css"

for m in MMM-SecondBrain MMM-SolarTheme MMM-CalendarLiveHeader; do
  [ -d "$STAGE/modules/$m" ] || continue
  while IFS= read -r live; do
    rel="${live#"$STAGE/modules/$m/"}"
    compare "$live" "modules/$m/$rel"
  done < <(find "$STAGE/modules/$m" -type f -name '*.js' -o -type f -name '*.css')
done

if [ "$DIFF_ONLY" -eq 1 ]; then
  say "Diff only. Nothing was written."
  exit 0
fi

# ---------------------------------------------------------------------------
# Only files the repo does not already own are written. Module source is not
# copied back -- the repo is authoritative for that, and pulling it would
# silently undo local work.
# ---------------------------------------------------------------------------
say "Writing files the repo is missing"

wrote=0

if [ -f "$STAGE/config/custom.css" ] && [ ! -f config/custom.css ]; then
  cp "$STAGE/config/custom.css" config/custom.css
  echo "  wrote config/custom.css ($(wc -l < config/custom.css | tr -d ' ') lines)"
  wrote=1
fi

if [ -d "$STAGE/modules/MMT-CalmCurrentWeather" ] && \
   [ ! -d modules/MMT-CalmCurrentWeather ]; then
  cp -r "$STAGE/modules/MMT-CalmCurrentWeather" modules/MMT-CalmCurrentWeather
  echo "  wrote modules/MMT-CalmCurrentWeather (was unresolved in third-party-modules.json)"
  wrote=1
fi

[ "$wrote" -eq 0 ] && echo "  nothing missing"

say "Done"
cat <<'EOF'

Anything marked DIFFERS above means the mirror and the repo have drifted apart.
Look at each one and decide which side is right -- the repo was not updated
automatically, because on a mirror that has been hand-edited that would quietly
discard whichever version you actually wanted.

Review, then commit:
  git status
  git diff
EOF
