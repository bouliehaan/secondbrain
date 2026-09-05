#!/usr/bin/env bash
#
# create-release.sh — cut a release from what is already on GitHub.
#
#   ./scripts/commit.sh "what and why"     put the code on GitHub, as often as you like
#   ./scripts/create-release.sh            turn what is on GitHub into a public release
#
# Deliberately separate from committing. Tagging on every push is how you reach
# v9.0.0 by Friday with nothing to show for the numbers, so the version bump is
# a decision, not a side effect.
#
# This releases origin/master, NOT your working tree, and refuses to run if the
# two have drifted — "release what is on GitHub" only means something if what is
# on GitHub is what you think it is.
#
#   ./scripts/create-release.sh                    patch bump
#   ./scripts/create-release.sh --minor            minor bump
#   ./scripts/create-release.sh --major            major bump
#   ./scripts/create-release.sh v1.5.0             pick the version outright
#   ./scripts/create-release.sh --minor "message"  annotate the tag
#   ./scripts/create-release.sh --yes              skip the confirmation
#
# Requires git and push access. gh is optional; without it the script reports
# where to look instead of watching and verifying, and says so.

set -euo pipefail

BRANCH="${RELEASE_BRANCH:-master}"
REPO="${RELEASE_REPO:-bouliehaan/secondbrain}"
ASSET="secondbrain_all.deb"

BUMP="patch"
VERSION=""
ASSUME_YES=0
MESSAGE=""

if [ -t 1 ]; then
  C_STEP='\033[1;33m'; C_DIM='\033[2m'; C_OK='\033[1;32m'; C_ERR='\033[1;31m'; C_OFF='\033[0m'
else
  C_STEP=''; C_DIM=''; C_OK=''; C_ERR=''; C_OFF=''
fi
say()  { printf "\n${C_STEP}==>${C_OFF} %s\n" "$*"; }
note() { printf "    ${C_DIM}%s${C_OFF}\n" "$*"; }
fail() { printf "\n${C_ERR}xx ${C_OFF}%s\n" "$*" >&2; exit 1; }

for arg in "$@"; do
  case "$arg" in
    --patch)               BUMP="patch" ;;
    --minor)               BUMP="minor" ;;
    --major)               BUMP="major" ;;
    --yes|-y)              ASSUME_YES=1 ;;
    v[0-9]*.[0-9]*.[0-9]*) VERSION="$arg" ;;
    -*)                    fail "unknown flag: $arg" ;;
    *)                     MESSAGE="$arg" ;;
  esac
done

# ---- preflight ---------------------------------------------------------------

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || fail "not inside a git repository."
cd "$(git rev-parse --show-toplevel)"

CURRENT="$(git rev-parse --abbrev-ref HEAD)"
[ "$CURRENT" = "$BRANCH" ] || fail "on '$CURRENT', expected '$BRANCH'.
    git switch $BRANCH"

say "Checking that origin/$BRANCH is what you think it is"
git fetch --quiet origin "$BRANCH"
git fetch --quiet --tags origin 2>/dev/null || true

# Both refusals, not warnings. What they prevent is shipping a release that
# silently lacks the change you cut it for, which you find out about after it
# is installed.
DIRTY="$(git status --porcelain)"
if [ -n "$DIRTY" ]; then
  printf '%s\n' "$DIRTY" | sed 's/^/      /'
  fail "the working tree has uncommitted changes, which will NOT be in the release.
    ./scripts/commit.sh \"what changed and why\""
fi

AHEAD="$(git rev-list --count "origin/$BRANCH..HEAD")"
if [ "$AHEAD" -gt 0 ]; then
  git log --oneline "origin/$BRANCH..HEAD" | sed 's/^/      /'
  fail "$AHEAD local commit(s) are not on origin/$BRANCH and would NOT be in the release.
    ./scripts/commit.sh"
fi

TARGET_SHA="$(git rev-parse "origin/$BRANCH")"

# ---- version -----------------------------------------------------------------

# Origin is the authority on what has been released, not the local tag list.
REMOTE_TAGS="$(git ls-remote --tags --refs origin 2>/dev/null || true)"
LATEST="$(printf '%s\n' "$REMOTE_TAGS" \
  | sed -n 's|.*refs/tags/v\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)$|\1|p' \
  | sort -t. -k1,1n -k2,2n -k3,3n | tail -1)"
[ -n "$LATEST" ] && LATEST="v$LATEST"

if [ -z "$VERSION" ]; then
  if [ -z "$LATEST" ]; then
    VERSION="v1.0.0"
  else
    # Sorted by version, not lexically: plain sort puts v1.10.0 before v1.9.0.
    IFS=. read -r MAJ MIN PAT <<<"${LATEST#v}"
    case "$BUMP" in
      patch) VERSION="v${MAJ}.${MIN}.$((PAT + 1))" ;;
      minor) VERSION="v${MAJ}.$((MIN + 1)).0" ;;
      major) VERSION="v$((MAJ + 1)).0.0" ;;
    esac
  fi
fi

git rev-parse -q --verify "refs/tags/$VERSION" >/dev/null \
  && fail "tag $VERSION already exists locally.
    ./scripts/create-release.sh --minor      to bump differently
    ./scripts/create-release.sh vX.Y.Z       to pick one"

if [ "$(git ls-remote --tags origin "refs/tags/$VERSION" 2>/dev/null | wc -l | tr -d ' ')" -ne 0 ]; then
  fail "tag $VERSION already exists on origin — pick another version."
fi

# ---- what is in it -----------------------------------------------------------

say "Release $VERSION  ${LATEST:+(previous: $LATEST)}"
note "commit:  ${TARGET_SHA:0:12}  on origin/$BRANCH"

if [ -n "$LATEST" ]; then
  LATEST_SHA="$(printf '%s\n' "$REMOTE_TAGS" | awk -v t="refs/tags/$LATEST" '$2==t{print $1; exit}')"
  git cat-file -e "${LATEST_SHA}^{commit}" 2>/dev/null \
    || git fetch --quiet origin "refs/tags/$LATEST" 2>/dev/null || true

  if git cat-file -e "${LATEST_SHA}^{commit}" 2>/dev/null; then
    COUNT="$(git rev-list --count "${LATEST_SHA}^{commit}..$TARGET_SHA")"
    [ "$COUNT" -eq 0 ] && fail "no commits since $LATEST — there is nothing new to release."
    echo
    git log --oneline "${LATEST_SHA}^{commit}..$TARGET_SHA" | sed 's/^/      /'
  fi
fi

if [ "$ASSUME_YES" -eq 0 ]; then
  echo
  read -r -p "Tag $VERSION and publish? [y/N] " reply
  case "$reply" in [yY]*) ;; *) fail "cancelled — nothing was tagged." ;; esac
fi

# ---- tag ---------------------------------------------------------------------

say "Tagging $VERSION"
git tag -a "$VERSION" "$TARGET_SHA" -m "${MESSAGE:-secondbrain $VERSION}"
git push origin "$VERSION"
note "pushed; the release workflow builds and attaches the .deb"

# ---- watch -------------------------------------------------------------------

if command -v gh >/dev/null 2>&1; then
  say "Watching the release workflow"
  sleep 8
  RUN_ID="$(gh run list --repo "$REPO" --workflow Release --limit 1 \
    --json databaseId -q '.[0].databaseId' 2>/dev/null || true)"
  if [ -n "$RUN_ID" ]; then
    gh run watch "$RUN_ID" --repo "$REPO" --exit-status \
      || note "the workflow did not finish cleanly — the check below is what counts"
  else
    note "could not find the workflow run; check https://github.com/$REPO/actions"
  fi
else
  note "gh not installed — not watching CI."
  note "  https://github.com/$REPO/actions"
fi

# ---- verify ------------------------------------------------------------------

# The .deb is attached to the Release itself, so the release IS the artifact.
# A half-finished run can leave a release with nothing attached, which is why
# this counts assets rather than checking the release exists.
if command -v gh >/dev/null 2>&1; then
  say "Verifying the release"
  ASSETS=""
  for _ in $(seq 1 20); do
    ASSETS="$(gh release view "$VERSION" --repo "$REPO" --json assets \
      -q '.assets[].name' 2>/dev/null || true)"
    [ -n "$ASSETS" ] && break
    sleep 6
  done

  [ -n "$ASSETS" ] && printf '%s\n' "$ASSETS" | sed 's/^/      /'
  [ -z "$ASSETS" ] && fail "no release assets for $VERSION.
    https://github.com/$REPO/actions"

  printf '%s\n' "$ASSETS" | grep -q '\.deb$' \
    || fail "the release has no .deb attached — that is the whole artifact."
  printf "    ${C_OK}ok${C_OFF} package attached\n"

  IS_DRAFT="$(gh release view "$VERSION" --repo "$REPO" --json isDraft -q .isDraft 2>/dev/null || echo unknown)"
  if [ "$IS_DRAFT" = "true" ]; then
    note "the release is a DRAFT — nobody can download it yet:"
    echo "      gh release edit $VERSION --repo $REPO --draft=false"
  fi
else
  say "Not verifying"
  note "gh is not installed, so the published package was not checked."
fi

printf "\n${C_OK}done.${C_OFF}  %s is released\n" "$VERSION"
echo "  Release:  https://github.com/$REPO/releases/tag/$VERSION"
echo "  Install:  https://github.com/$REPO/releases/latest/download/$ASSET"
