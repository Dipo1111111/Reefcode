#!/usr/bin/env bash
# Regenerate vendor/pi.patch from the pinned commit and the vendored tree.
#
# The patch is the only supported way to change the vendored core (ADR-001), so it must be
# regenerated, never hand-edited. Build output, installed packages, and provider catalogues are
# excluded: they are generated, not source.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

pin=$(grep '^commit:' vendor/PIN | awk '{print $2}')
source_repo="${REEF_PI_SOURCE:-$root/../../research/pi}"
out="vendor/pi.patch"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

git -C "$source_repo" archive "$pin" | tar -x -C "$work"
git -C "$work" init -q
git -C "$work" add -A
git -C "$work" -c user.email=ci@reef -c user.name=ci commit -qm "pin $pin"

rsync -a --delete \
  --exclude node_modules --exclude dist --exclude .git --exclude .turbo --exclude .reef \
  --exclude 'packages/ai/src/providers/data' \
  "$root/vendor/pi/" "$work/"

git -C "$work" add -A
git -C "$work" diff --cached --binary --src-prefix=a/ --dst-prefix=b/ > "$out"

files=$(git -C "$work" diff --cached --stat | tail -1)
echo "patch-gen: $pin · $files"
echo "patch-gen: wrote $out ($(wc -l < "$out" | tr -d ' ') lines)"
