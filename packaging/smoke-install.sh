#!/usr/bin/env bash
#
# Install a built package the way the README says and require the wall to come
# up. CI runs this on a clean runner before a package can be published:
#
#   packaging/smoke-install.sh dist/secondbrain_amd64.deb
#
# --no-install-recommends only to keep chromium out: on Ubuntu it is a snap,
# which a CI runner installs slowly or not at all, and the display is not what
# this checks. Everything the server needs is a hard dependency.
set -euo pipefail

deb="$1"
# apt only treats an argument as a file when it looks like a path.
case "$deb" in /*|./*) ;; *) deb="./$deb" ;; esac
since="$(date +%s)"
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends "$deb"

port=43761
fail() {
    echo "smoke: $*" >&2
    systemctl status magicmirror --no-pager || true
    sudo journalctl -u magicmirror --since "@$since" --no-pager | tail -60 || true
    exit 1
}

for _ in $(seq 1 60); do
    curl -fsS -o /dev/null "http://127.0.0.1:${port}/" && break
    sleep 1
done
curl -fsS -o /dev/null "http://127.0.0.1:${port}/" || fail "the dashboard never answered"

# The page cannot run without the positions MagicMirror writes at startup; a
# 404 here is a black wall that the index page above would not reveal.
curl -fsS "http://127.0.0.1:${port}/js/positions.js" | grep -q modulePositions \
    || fail "js/positions.js is not being served"
curl -fsS -o /dev/null "http://127.0.0.1:${port}/css/secondbrain.css" \
    || fail "the wall's stylesheet is not being served"

test -s /opt/MagicMirror/config/config.js || fail "no config.js was seeded"
if sudo journalctl -u magicmirror --since "@$since" --no-pager | grep -E "Cannot find module|unable to write"; then
    fail "the server logged a broken install"
fi
echo "smoke: secondbrain installed and serving on :${port}"
