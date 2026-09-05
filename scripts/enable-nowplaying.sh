#!/usr/bin/env bash
#
# enable-nowplaying.sh -- install the samo credential on the mirror and prove it
# works, in one pass.
#
# Now Playing is the only part of this dashboard that needs a credential the
# repo cannot carry and the deploy cannot invent: a samo API token. Everything
# else about the module ships with scripts/deploy.sh. This script is the one
# step that needs you.
#
#   scripts/enable-nowplaying.sh                 # prompts for the token
#   scripts/enable-nowplaying.sh --check         # test what is installed, change nothing
#   scripts/enable-nowplaying.sh --show-device   # print the device the wall will follow
#
# Get a token from samo's web UI (http://192.168.1.10:6969) under your user's
# API tokens, or POST /api/v1/users/me/tokens with {"label":"wall"}.
#
# The token is read without echo and handed to the mirror over stdin -- never as
# a command argument, which would put it in the mirror's process list where any
# local user could read it. (samo-radio itself has this bug: it passes its device
# token to ffmpeg in argv, visible in ps.)
#
set -euo pipefail

REMOTE="${SECONDBRAIN_REMOTE:-jake@192.168.1.10}"
SERVICE_USER="${SECONDBRAIN_SERVICE_USER:-calendar-display}"
CONFIG_DIR="/etc/magicmirror-secondbrain"
SAMO_URL="${SAMO_URL:-http://127.0.0.1:6969}"

MODE="install"

for arg in "$@"; do
  case "$arg" in
    --check)       MODE="check" ;;
    --show-device) MODE="device" ;;
    -h|--help)     sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

say()  { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
note() { printf '    %s\n' "$1"; }
fail() { printf '\n\033[1;31mxx \033[0m%s\n' "$1" >&2; exit 1; }

# ---------------------------------------------------------------------------
# The mirror has to be up before any of this means anything.
# ---------------------------------------------------------------------------
say "Checking the mirror"
ssh -o BatchMode=yes -o ConnectTimeout=8 "$REMOTE" true 2>/dev/null ||
  fail "Cannot reach ${REMOTE} over SSH. Set SECONDBRAIN_REMOTE if it moved, or check it is powered on."
note "reachable"

# samo-server runs on the same box, so this is a loopback check run remotely.
if ! ssh "$REMOTE" "curl -fsS -m 5 -o /dev/null '${SAMO_URL}/health'" 2>/dev/null; then
  fail "samo-server is not answering on ${SAMO_URL} from the mirror. Is the container up? (docker ps)"
fi
note "samo-server is up"

# ---------------------------------------------------------------------------
# Read back what is installed. Needs sudo, because the credential directory is
# 0700 and owned by the service user -- which is the point of it.
# ---------------------------------------------------------------------------
read_installed_token () {
  # stderr is deliberately NOT suppressed here: sudo's password prompt goes to
  # it, and swallowing it leaves the script apparently hung at a blank line.
  ssh -t "$REMOTE" "sudo cat '${CONFIG_DIR}/samo.json'" |
    node -e '
      let raw = "";
      process.stdin.on("data", (d) => { raw += d; });
      process.stdin.on("end", () => {
        try { process.stdout.write(String(JSON.parse(raw).token || "")); }
        catch { process.stdout.write(""); }
      });
    '
}

# ---------------------------------------------------------------------------
# Ask samo whether a token actually works, and what it can see. Verifying before
# installing is the whole point: a token that 401s would otherwise show up as a
# card that silently never appears, which is indistinguishable from every other
# reason a card never appears.
# ---------------------------------------------------------------------------
probe_token () {
  local token="$1"
  printf '%s' "$token" | ssh "$REMOTE" "
    read -r TOKEN
    curl -fsS -m 8 -H \"Authorization: Bearer \$TOKEN\" '${SAMO_URL}/api/v1/samo-radio/devices' 2>/dev/null
  "
}

describe_devices () {
  node -e '
    let raw = "";
    process.stdin.on("data", (d) => { raw += d; });
    process.stdin.on("end", () => {
      let list;
      try { list = JSON.parse(raw); } catch { console.log("    (unreadable response)"); return; }
      if (!Array.isArray(list)) list = list.items || [];
      if (list.length === 0) {
        console.log("    no samo-radio devices are registered.");
        return;
      }
      for (const d of list) {
        const s = d.state || {};
        const c = s.channel || {};
        const playing = [c.artist, c.title].filter(Boolean).join(" - ");
        console.log(`    ${d.id}  ${d.name || "(unnamed)"}`);
        console.log(`      status  ${s.status || "unreachable"}${s.mode ? " / " + s.mode : ""}`);
        if (c.name) console.log(`      tuned   ${c.name}`);
        if (playing) console.log(`      playing ${playing}`);
        if (!playing && s.status === "playing") {
          console.log("      playing (nothing announced yet -- the daemon refreshes every 10s)");
        }
        if (d.lastError) console.log(`      error   ${d.lastError}`);
      }
    });
  '
}

# ---------------------------------------------------------------------------
# --check / --show-device: read-only paths.
# ---------------------------------------------------------------------------
if [ "$MODE" != "install" ]; then
  say "Reading the installed credential"
  note "sudo will prompt -- the credential directory is 0700 and owned by ${SERVICE_USER}"

  TOKEN="$(read_installed_token || true)"

  if [ -z "$TOKEN" ]; then
    fail "No usable token at ${CONFIG_DIR}/samo.json. Run this script with no arguments to install one."
  fi

  say "Asking samo what the radio is doing"
  RESPONSE="$(probe_token "$TOKEN" || true)"

  if [ -z "$RESPONSE" ]; then
    fail "The installed token was rejected by samo, or the request failed. Re-run with no arguments to replace it."
  fi

  printf '%s' "$RESPONSE" | describe_devices
  echo
  exit 0
fi

# ---------------------------------------------------------------------------
# Install.
# ---------------------------------------------------------------------------
say "The samo API token"
note "Create one in samo's web UI under your user's API tokens."
note "It is not echoed, and it is sent to the mirror over stdin, not on a command line."
printf '\n    token: '
read -rs TOKEN
printf '\n'

[ -n "$TOKEN" ] || fail "No token entered; nothing was changed."

say "Verifying the token against samo before installing it"
RESPONSE="$(probe_token "$TOKEN" || true)"

[ -n "$RESPONSE" ] ||
  fail "samo rejected that token, so it was NOT installed. Check you copied the whole thing."

note "accepted"
echo
printf '%s' "$RESPONSE" | describe_devices

# ---------------------------------------------------------------------------
# Write it, in two connections.
#
# It has to be two, and the reason is worth stating because the obvious single
# version is broken: you cannot both pipe the token into ssh AND leave stdin
# free for sudo's password prompt. Piping makes stdin a pipe, `ssh -t` then
# refuses to allocate a terminal ("Pseudo-terminal will not be allocated"),
# and sudo has nowhere to ask. The first version of this script did exactly
# that and died at the last step.
#
# So: connection one carries the token as file content, with no sudo and so no
# need for a terminal. Connection two has a real terminal and moves the file
# into place. The token is never an argument to any command, on either end --
# argv is world-readable in /proc, which is how samo-radio leaks its own device
# token to anyone who runs ps.
# ---------------------------------------------------------------------------
say "Staging the credential on the mirror"

STAGED='$HOME/.samo-wall.json'

printf '{\n  "baseUrl": "%s",\n  "token": "%s",\n  "deviceId": "",\n  "timeoutMs": 6000\n}\n' \
  "$SAMO_URL" "$TOKEN" |
  ssh "$REMOTE" "umask 077 && cat > ${STAGED}" ||
  fail "Could not stage the credential on the mirror. Nothing was changed."

note "staged, mode 0600"

say "Installing ${CONFIG_DIR}/samo.json"
note "sudo will prompt -- the credential directory is 0700 and owned by ${SERVICE_USER}"

# The staged copy is removed whether or not sudo succeeds, so a mistyped
# password does not leave the token sitting in a home directory.
ssh -t "$REMOTE" "
  sudo install -o ${SERVICE_USER} -g ${SERVICE_USER} -m 600 ${STAGED} '${CONFIG_DIR}/samo.json'
  rc=\$?
  rm -f ${STAGED}
  [ \$rc -eq 0 ] && echo '    installed'
  exit \$rc
" || fail "Install failed. The staged copy was removed; nothing was changed at ${CONFIG_DIR}."

# ---------------------------------------------------------------------------
# The helper reads samo.json when the browser sends its config, which happens on
# page load and never again. Without this reload the file sits there unread and
# the card stays dark -- the same trap the calendar fetchers fall into.
# ---------------------------------------------------------------------------
say "Reloading the kiosk browser so the module picks it up"
ssh -t "$REMOTE" "sudo pkill -u ${SERVICE_USER} -f magicmirror-kiosk" ||
  note "no kiosk browser was running; it will read the file when it starts"

say "Watching for the module to come up"
sleep 10

ssh "$REMOTE" "journalctl -u magicmirror --since '-60s' --no-pager 2>/dev/null | grep -i nowplaying | tail -15" ||
  note "nothing logged yet"

cat <<'DONE'

Done. What healthy looks like in that log:

  [NowPlaying] Watching samo at http://127.0.0.1:6969 every 10s (device chosen automatically).
  [NowPlaying] Billie Eilish - Bad Guy (Jake Channel) [artwork]

If you see "No samo.json" the file did not land. If you see nothing at all, the
module is not deployed yet -- run scripts/deploy.sh first.

Re-check any time, without changing anything:

  scripts/enable-nowplaying.sh --check

DONE
