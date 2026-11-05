#!/usr/bin/env bash
# Apply vendor/pi.patch to a clean checkout of the pinned commit and fail if it does not apply.
# This is the CI job that keeps the vendored tree and the patch honest (docs/02 §13).
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

pin=$(grep '^commit:' vendor/PIN | awk '{print $2}')
source_repo="${REEF_PI_SOURCE:-$root/../../research/pi}"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

git -C "$source_repo" archive "$pin" | tar -x -C "$work"
git -C "$work" init -q
git -C "$work" add -A
git -C "$work" -c user.email=ci@reef -c user.name=ci commit -qm "pin $pin"
git -C "$work" apply --check "$root/vendor/pi.patch"
echo "patch-check: vendor/pi.patch applies cleanly to $pin"

# Applying is not enough: a stale patch applies fine and no longer describes the tree. Prove the
# patch reproduces the vendored source, so the vendored tree can never drift from the patch.
if [ "${1:-}" = "--verify" ]; then
  applied=$(mktemp -d)
  trap 'rm -rf "$work" "$applied"' EXIT
  git -C "$source_repo" archive "$pin" | tar -x -C "$applied"
  git -C "$applied" apply "$root/vendor/pi.patch"
  if ! diff -rq \
    --exclude=node_modules --exclude=dist --exclude=.git --exclude=.turbo \
    --exclude=.reef --exclude=data \
    "$applied" "$root/vendor/pi" > /tmp/reef-patch-drift.txt 2>&1; then
    echo "patch-check: vendor/pi.patch does NOT reproduce vendor/pi:" >&2
    head -20 /tmp/reef-patch-drift.txt >&2
    echo "patch-check: run scripts/patch-gen.sh" >&2
    exit 1
  fi
  echo "patch-check: vendored tree is exactly the patch"
fi
