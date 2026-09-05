#!/usr/bin/env bash
#
# Assemble the .deb. Run from the repo root; CI calls this, and so can you.
#
#   VERSION=1.3.0 packaging/build-deb.sh
#
# There is no compile step -- everything here is JavaScript, Python and config.
# The one build action is vendoring MMM-SecondBrain's production dependencies,
# so installing the package never needs the network.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

VERSION="${VERSION:-$(git describe --tags --always 2>/dev/null || echo 0.0.0)}"
VERSION="${VERSION#v}"
ARCH=all
PKG=secondbrain
ROOT="build/deb"
OUT="dist"

MODULES=(MMM-SecondBrain NowPlaying FreezeWatch MMM-SolarTheme MMM-CalendarLiveHeader)

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
rsync -a --exclude 'config/' --exclude '.git' "$CACHE/mm/" "$MM_DEST/"
place 0644 "$CACHE/mm/LICENSE.md" "$ROOT/usr/share/doc/$PKG/licenses/MagicMirror-LICENSE.md"

say "Bundling pinned third-party modules"
node -e '
  for (const m of require("./config/third-party-modules.json").modules) {
    console.log([m.name, m.repo, m.ref].join("\t"));
  }
' | while IFS=$'\t' read -r name repo ref; do
    echo "    ${name} @ ${ref}"
    dir="$CACHE/tp/$name"
    if [ ! -d "$dir" ]; then
        mkdir -p "$CACHE/tp"
        git -c advice.detachedHead=false clone --quiet --depth 1 \
            --branch "$ref" "$repo" "$dir"
    fi
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


place 0755 system/openbox/autostart "$ROOT/usr/share/$PKG/openbox/autostart"
place 0644 system/systemd/magicmirror.service "$ROOT/lib/systemd/system/magicmirror.service"

place 0644 system/lightdm/50-calendar-kiosk.conf "$ROOT/etc/lightdm/lightdm.conf.d/50-calendar-kiosk.conf"
place 0644 packaging/chrony/secondbrain.sources "$ROOT/etc/chrony/sources.d/secondbrain.sources"
place 0644 packaging/default-secondbrain "$ROOT/etc/default/secondbrain"

place 0644 README.md "$ROOT/usr/share/doc/$PKG/README.md"
place 0644 packaging/debian/copyright "$ROOT/usr/share/doc/$PKG/copyright"

# config.js ships as an example and nothing more. The live one on the wall is
# the only copy carrying the private calendar urls; installing over it is the
# outage this package exists to stop repeating.
place 0644 config/config.js "$ROOT/usr/share/doc/$PKG/config.example.js"
# Keep the directory structure. Two of these are both called
# personal.example.json -- one Gmail, one Proton -- so flattening on basename
# silently ships one and drops the other. The nesting is also the shape they
# need once they are filled in under /etc/magicmirror-secondbrain/.
while IFS= read -r f; do
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

say "Control files"
install -d -m 0755 "$ROOT/DEBIAN"
# Installed-Size is what apt reports as the disk cost before you agree to the
# install. dpkg-deb does not work it out for a hand-built tree, and without the
# field apt shows nothing at all. In KiB, excluding DEBIAN/ itself.
INSTALLED_SIZE="$(du -sk --exclude=DEBIAN "$ROOT" 2>/dev/null | cut -f1 \
    || du -sk "$ROOT" | cut -f1)"
sed -e "s/@VERSION@/${VERSION}/" -e "s/@ARCH@/${ARCH}/" \
    -e "s/@INSTALLED_SIZE@/${INSTALLED_SIZE}/" \
    packaging/debian/control > "$ROOT/DEBIAN/control"
for script in postinst prerm postrm; do
    install -m 0755 "packaging/debian/$script" "$ROOT/DEBIAN/$script"
done

# Files dpkg must not overwrite on upgrade: everything under /etc that a person
# is expected to edit.
cat > "$ROOT/DEBIAN/conffiles" <<'EOF'
/etc/default/secondbrain
/etc/lightdm/lightdm.conf.d/50-calendar-kiosk.conf
/etc/chrony/sources.d/secondbrain.sources
EOF

say "Building"
# Unversioned filename on purpose, the same as samo-radio: it keeps
# releases/latest/download/secondbrain_all.deb a URL that never goes stale, so
# the documented install stays one command forever. The real version is in the
# control file, which is what dpkg and apt read.
dpkg-deb --build --root-owner-group "$ROOT" "$OUT/${PKG}_${ARCH}.deb"
ls -l "$OUT"
