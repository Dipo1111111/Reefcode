#!/usr/bin/env bash
# Assemble the publishable tarball for `reef-harness`.
#
#   scripts/package.sh            # build build/package and pack a tarball
#   scripts/package.sh --install  # ...and install it globally into a scratch prefix to prove it
#
# The published package is not the repository: it is the bundle, the entry point, and the legal
# files. Keeping assembly here means what users install can be rebuilt from a commit, and the
# tarball contents are reviewable before they leave the machine.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bundle="$root/vendor/pi/packages/coding-agent/dist/bundle"
out="$root/build/package"

install_prefix=""
[ "${1:-}" = "--install" ] && install_prefix="${2:-/tmp/reef-prefix}"

if [ ! -d "$bundle" ]; then
	echo "package: no bundle at $bundle" >&2
	echo "package: run 'npm run build' first" >&2
	exit 70
fi

rm -rf "$out"
mkdir -p "$out/dist"
cp -R "$bundle" "$out/dist/bundle"
cp -R "$root/apps/reef/bin" "$out/bin"
cp "$root/apps/reef/package.json" "$out/package.json"
cp "$root/LICENSE" "$root/NOTICE" "$out/"
[ -f "$root/README.md" ] && cp "$root/README.md" "$out/README.md"

# The license text covers the vendored work too; shipping the patch keeps the provenance auditable.
mkdir -p "$out/vendor"
cp "$root/vendor/pi.patch" "$out/vendor/pi.patch"

version="$(node -p "require('$out/package.json').version")"
echo "package: assembled $out (reef-harness $version)"

tarball="$(cd "$out" && npm pack --silent)"
mv "$out/$tarball" "$root/build/$tarball"
echo "package: $root/build/$tarball"
echo "package: $(du -h "$root/build/$tarball" | cut -f1)"

if [ -n "$install_prefix" ]; then
	rm -rf "$install_prefix"
	npm install --silent --no-audit --no-fund --prefix "$install_prefix" "$root/build/$tarball"
	echo "package: installed into $install_prefix"
fi
