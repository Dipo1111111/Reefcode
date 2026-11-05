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
