#!/usr/bin/env bash
#
# Assemble the .deb. Run from the repo root; CI calls this, and so can you.
#
#   VERSION=1.3.0 packaging/build-deb.sh
#
# There is no compile step -- everything here is JavaScript, Python and config.
# The build actions are vendoring MMM-SecondBrain's production dependencies and
# bundling a Node runtime, so installing the package never needs the network
# and never needs a node the distribution does not have.
#
# One package per architecture (ARCHES, default amd64 arm64 armhf). They differ
# only in the bundled node binary: every vendored dependency is plain
# JavaScript.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

VERSION="${VERSION:-$(git describe --tags --always 2>/dev/null || echo 0.0.0)}"
VERSION="${VERSION#v}"
# dpkg needs a version that starts with a digit. A checkout with no tags (CI's
# shallow clone) describes itself as a bare commit hash, so make that a valid
# pre-release version rather than a failed build.
case "$VERSION" in
    [0-9]*) ;;
    *) VERSION="0.0.0+${VERSION}" ;;
esac
ARCHES="${ARCHES:-amd64 arm64 armhf}"
PKG=secondbrain
ROOT="build/deb"
OUT="dist"

MODULES=(MMM-SecondBrain NowPlaying FreezeWatch StatusLine Rail WeatherTheme MMM-SolarTheme MMM-CalendarLiveHeader)

say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

# GNU install has -D to create leading directories; the BSD install on macOS
# does not, and silently means something else by that flag. Doing the mkdir
# ourselves keeps the build working on whichever machine it is run from.
place() {
    local mode="$1" src="$2" dst="$3"
    mkdir -p "$(dirname "$dst")"
    install -m "$mode" "$src" "$dst"
}

rm -rf "$ROOT"
mkdir -p "$ROOT" "$OUT"

# ---------------------------------------------------------------------------
# Bundle MagicMirror and the two pinned third-party modules.
#
# Same reasoning as bundling ffmpeg in samo-server: it is MIT-licensed open
# source the dashboard cannot run without, it is not in apt, and making people
# install it themselves is the difference between a two-command install and a
# procedure. Versions come from config/third-party-modules.json so the pins live
# in one place.
#
# --omit=optional is not cosmetic: MagicMirror lists electron as an optional
# dependency, and the unit runs `node ./serveronly` with Chromium as the
# display. Without this flag every package carries a ~200MB Electron that
# nothing ever executes.
# ---------------------------------------------------------------------------
MM_VERSION="$(node -p 'require("./config/third-party-modules.json").magicmirror.version')"
MM_REPO="$(node -p 'require("./config/third-party-modules.json").magicmirror.repo')"
CACHE="build/cache"
mkdir -p "$CACHE"

say "Bundling MagicMirror ${MM_VERSION}"
TARBALL="$CACHE/magicmirror-${MM_VERSION}.tar.gz"
if [ ! -f "$TARBALL" ]; then
    curl -fsSL --retry 3 -o "$TARBALL" \
        "${MM_REPO}/archive/refs/tags/v${MM_VERSION}.tar.gz"
fi
rm -rf "$CACHE/mm"
mkdir -p "$CACHE/mm"
tar xzf "$TARBALL" -C "$CACHE/mm" --strip-components=1

# engine-strict is off for the *build* only. MagicMirror pins node
# ">=22.21.1 <23 || >=24" and refuses to install under anything else, which
# would mean the package could only be built on a box running exactly the right
# node. The dependencies are pure JavaScript, so the tree is identical either
# way; what actually matters is the node at runtime, and secondbrain-server
# checks that before it starts.
( cd "$CACHE/mm" && npm install --no-audit --no-fund --no-update-notifier \
    --omit=dev --omit=optional --engine-strict=false >/dev/null )

MM_DEST="$ROOT/opt/MagicMirror"
mkdir -p "$MM_DEST"
# Everything except config/. The wall's config.js carries the private calendar
# urls and is the only copy; dpkg must never own that path.
#
# Anchored: '/config/' is MagicMirror's own config directory and nothing else.
# Unanchored, the pattern matched every directory called config at any depth --
# including node_modules/eslint/lib/config/, which MagicMirror requires at
# startup -- and every fresh install of 1.1.0 and 1.2.0 crash-looped on
# "Cannot find module '../config/default-config'". It only worked on a wall
# whose MagicMirror predated the package.
rsync -a --exclude '/config/' --exclude '.git' "$CACHE/mm/" "$MM_DEST/"
place 0644 "$CACHE/mm/LICENSE.md" "$ROOT/usr/share/doc/$PKG/licenses/MagicMirror-LICENSE.md"

say "Bundling pinned third-party modules"
node -e '
  for (const m of require("./config/third-party-modules.json").modules) {
    console.log([m.name, m.repo, m.ref].join("\t"));
  }
' | while IFS=$'\t' read -r name repo ref; do
    echo "    ${name} @ ${ref}"
    dir="$CACHE/tp/$name"
    # A cached clone is only worth keeping if git has its submodules checked
    # out (a status line starting with anything but a space says it has not).
    # Builds before this script knew about submodules left CX3_Shared as an
    # empty directory -- or, after a repair by hand, as files git did not put
    # there -- and git refuses to clone a submodule into a directory that
    # already has anything in it. Starting over is simpler than repairing.
    if [ -d "$dir" ] && git -C "$dir" submodule status | grep -q '^[-+U]'; then
        echo "    (cached clone has no submodules; discarding it)"
        rm -rf "$dir"
    fi
    if [ ! -d "$dir" ]; then
        mkdir -p "$CACHE/tp"
        git -c advice.detachedHead=false clone --quiet --depth 1 \
            --branch "$ref" "$repo" "$dir"
    fi
    # Both modules import CX3_Shared/CX3_shared.mjs at runtime, and a plain
    # clone leaves that submodule as an empty directory: the package installs,
    # the module loads, and the month grid never draws. Run this every build,
    # not only after a fresh clone, so a cache from before this step is fixed
    # too. Shallow, the same as the parent, and GitHub serves the pinned SHA.
    git -C "$dir" submodule update --quiet --init --depth 1
    if [ ! -f "$dir/CX3_Shared/CX3_shared.mjs" ]; then
        echo "error: ${name}: CX3_Shared/CX3_shared.mjs is missing after checkout." >&2
        echo "       The module imports it at runtime; without it the calendar" >&2
        echo "       never renders, so this package must not be built." >&2
        exit 1
    fi
    # --exclude '.git' also drops the submodule's .git pointer file, which
    # would otherwise ship pointing at a directory that does not exist.
    rsync -a --exclude '.git' "$dir/" "$MM_DEST/modules/$name/"
    for lic in LICENSE LICENSE.md LICENSE.txt; do
        [ -f "$dir/$lic" ] && place 0644 "$dir/$lic" \
            "$ROOT/usr/share/doc/$PKG/licenses/${name}-${lic}" && break
    done
done

say "Vendoring production dependencies"
# --omit=dev, so imapflow and mailparser ship but nothing else does. Done into
# the staging tree rather than the source tree so a build never dirties the
# working copy.
for m in "${MODULES[@]}"; do
    rsync -a --exclude node_modules --exclude __pycache__ \
        "modules/$m" "$MM_DEST/modules/"
done
( cd "$MM_DEST/modules/MMM-SecondBrain" && npm ci --omit=dev --no-audit --no-fund >/dev/null )

say "Placing files"
place 0755 packaging/bin/secondbrain-server "$ROOT/usr/bin/secondbrain-server"
place 0755 system/bin/calendar-kiosk "$ROOT/usr/bin/calendar-kiosk"
place 0755 clock/magicmirror-python-clock.py "$ROOT/usr/bin/magicmirror-python-clock.py"

# The page's Rajdhani and the clock's Orbitron are vendored OFL fonts.
# Install both system-wide; postinst refreshes their fontconfig caches.
for family in rajdhani orbitron; do
    for f in config/fonts/"$family"/*.ttf; do
        place 0644 "$f" "$ROOT/usr/share/fonts/truetype/$family/$(basename "$f")"
    done
done
place 0644 config/fonts/rajdhani/OFL.txt "$ROOT/usr/share/doc/$PKG/licenses/Rajdhani-OFL.txt"
place 0644 config/fonts/orbitron/OFL.txt "$ROOT/usr/share/doc/$PKG/licenses/Orbitron-OFL.txt"


place 0755 system/openbox/autostart "$ROOT/usr/share/$PKG/openbox/autostart"
place 0644 system/systemd/magicmirror.service "$ROOT/lib/systemd/system/magicmirror.service"

place 0644 system/lightdm/50-calendar-kiosk.conf "$ROOT/etc/lightdm/lightdm.conf.d/50-calendar-kiosk.conf"
place 0644 packaging/chrony/secondbrain.sources "$ROOT/etc/chrony/sources.d/secondbrain.sources"
place 0644 packaging/default-secondbrain "$ROOT/etc/default/secondbrain"

place 0644 README.md "$ROOT/usr/share/doc/$PKG/README.md"
place 0644 packaging/debian/copyright "$ROOT/usr/share/doc/$PKG/copyright"

# The wall's look. Shipped where dpkg owns it, so an upgrade brings the
# stylesheet with it; the example config points MagicMirror at it with
# customCss, and a config without that key keeps using config/custom.css. The
# fonts sit beside it because the stylesheet falls back to them by relative url
# when the page is opened from a machine without them installed.
place 0644 config/custom.css "$MM_DEST/css/secondbrain.css"
for f in config/fonts/rajdhani/*.ttf; do
    place 0644 "$f" "$MM_DEST/css/fonts/rajdhani/$(basename "$f")"
done

# The example wall, and what postinst seeds the first install from. Not the
# repo's config.js -- that is the maintainer's own wall and carries his
# calendars and location. /usr/share/$PKG rather than only /usr/share/doc,
# because minimised images (cloud, container) exclude /usr/share/doc and the
# seed would silently have nothing to copy.
place 0644 config/config.example.js "$ROOT/usr/share/$PKG/config.example.js"
place 0644 config/config.example.js "$ROOT/usr/share/doc/$PKG/config.example.js"
place 0755 packaging/seed-config.py "$ROOT/usr/share/$PKG/seed-config.py"
# Keep the directory structure. Two of these are both called
# personal.example.json -- one Gmail, one Proton -- so flattening on basename
# silently ships one and drops the other. The nesting is also the shape they
# need once they are filled in under /etc/magicmirror-secondbrain/.
while IFS= read -r f; do
    place 0644 "$f" "$ROOT/usr/share/$PKG/examples/${f#config/secondbrain/}"
    place 0644 "$f" "$ROOT/usr/share/doc/$PKG/examples/${f#config/secondbrain/}"
done < <(find config/secondbrain -name '*.example.json' | sort)

say "Pruning vendored scaffolding"
# Upstream packages ship their own repo furniture -- agent configs, CI files,
# editor settings -- that has no business inside this package. imapflow ships a
# CLAUDE.md, for instance. None of it is executed; it is just other people's
# clutter riding along in your .deb.
find "$ROOT/opt/MagicMirror" \
    \( -name 'CLAUDE.md' -o -name 'AGENTS.md' -o -name '.editorconfig' \
       -o -name '.travis.yml' -o -name '.eslintrc*' -o -name '.npmignore' \) \
    -type f -delete 2>/dev/null || true
find "$ROOT/opt/MagicMirror" -type d \
    \( -name '.github' -o -name '.vscode' -o -name '.idea' \) \
    -exec rm -rf {} + 2>/dev/null || true
echo "    removed"

say "Bundling Node ${NODE_VERSION:=$(node -p 'require("./config/third-party-modules.json").node.version')}"
# MagicMirror needs node >=22.21.1. Ubuntu 26.04 ships one; Ubuntu 24.04 (18),
# Debian 13 and Raspberry Pi OS (20) do not, so depending on the distribution's
# nodejs made the documented one-line install fail on most of the machines a
# wall display actually runs on. The official build, checked against its
# published SHA-256, goes in /usr/lib/$PKG/node and secondbrain-server prefers it.
NODE_DIST="$(node -p 'require("./config/third-party-modules.json").node.dist')"
curl -fsSL --retry 3 -o "$CACHE/node-SHASUMS256-${NODE_VERSION}.txt" \
    "${NODE_DIST}/v${NODE_VERSION}/SHASUMS256.txt"
sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }
node_arch() {
    case "$1" in
        amd64) echo x64 ;;
        arm64) echo arm64 ;;
        armhf) echo armv7l ;;
        *) echo "no node build for $1" >&2; return 1 ;;
    esac
}

# Files dpkg must not overwrite on upgrade: everything under /etc that a person
# is expected to edit.
CONFFILES='/etc/default/secondbrain
/etc/lightdm/lightdm.conf.d/50-calendar-kiosk.conf
/etc/chrony/sources.d/secondbrain.sources'

for arch in $ARCHES; do
    say "Building ${PKG}_${arch}.deb"
    tarball="node-v${NODE_VERSION}-linux-$(node_arch "$arch").tar.xz"
    if [ ! -f "$CACHE/$tarball" ]; then
        curl -fsSL --retry 3 -o "$CACHE/$tarball" "${NODE_DIST}/v${NODE_VERSION}/${tarball}"
    fi
    want="$(grep "  ${tarball}\$" "$CACHE/node-SHASUMS256-${NODE_VERSION}.txt" | cut -d' ' -f1)"
    got="$(sha256 "$CACHE/$tarball")"
    if [ -z "$want" ] || [ "$want" != "$got" ]; then
        echo "error: $tarball does not match nodejs.org's SHA-256 (want '$want', got '$got')" >&2
        rm -f "$CACHE/$tarball"
        exit 1
    fi

    tree="build/deb-$arch"
    rm -rf "$tree"
    cp -a "$ROOT" "$tree"
    mkdir -p "$tree/usr/lib/$PKG/node"
    tar -xJf "$CACHE/$tarball" -C "$tree/usr/lib/$PKG/node" --strip-components=1 \
        "${tarball%.tar.xz}/bin/node" "${tarball%.tar.xz}/LICENSE"
    chmod 0755 "$tree/usr/lib/$PKG/node/bin/node"

    install -d -m 0755 "$tree/DEBIAN"
    # Installed-Size is what apt reports as the disk cost before you agree to
    # the install. dpkg-deb does not work it out for a hand-built tree, and
    # without the field apt shows nothing at all. In KiB, excluding DEBIAN/.
    INSTALLED_SIZE="$(du -sk --exclude=DEBIAN "$tree" 2>/dev/null | cut -f1 \
        || du -sk "$tree" | cut -f1)"
    sed -e "s/@VERSION@/${VERSION}/" -e "s/@ARCH@/${arch}/" \
        -e "s/@INSTALLED_SIZE@/${INSTALLED_SIZE}/" \
        packaging/debian/control > "$tree/DEBIAN/control"
    for script in postinst prerm postrm; do
        install -m 0755 "packaging/debian/$script" "$tree/DEBIAN/$script"
    done
    printf '%s\n' "$CONFFILES" > "$tree/DEBIAN/conffiles"

    # Unversioned filename on purpose, the same as samo-radio: it keeps
    # releases/latest/download/secondbrain_<arch>.deb a URL that never goes
    # stale, so the documented install stays one command forever. The real
    # version is in the control file, which is what dpkg and apt read.
    dpkg-deb --build --root-owner-group "$tree" "$OUT/${PKG}_${arch}.deb"
done
ls -l "$OUT"
