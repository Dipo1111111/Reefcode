#!/usr/bin/env bash
# Publish the current build to npm.
#
#   scripts/publish.sh            # publish the version in apps/reef/package.json
#
# Credentials come from ~/.reef/npm.env (NPM_TOKEN=...), falling back to ~/.npmrc. The token is
# passed through a throwaway userconfig so a failed run cannot leave a half-written config behind.
#
# With 2FA in auth-and-writes mode and a non-OTP token, npm stages the release: the command returns
# success, but the version only goes live once approved at
#   https://www.npmjs.com/package/reef-code/staged
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
version="$(node -p "require('$root/apps/reef/package.json').version")"
tarball="$root/build/reef-code-$version.tgz"

[ -f "$tarball" ] || bash "$root/scripts/package.sh"

token="${NPM_TOKEN:-}"
if [ -z "$token" ] && [ -f "$HOME/.reef/npm.env" ]; then
	# shellcheck disable=SC1091
	. "$HOME/.reef/npm.env"
	token="${NPM_TOKEN:-}"
fi

if [ -n "$token" ]; then
	tmp="$(mktemp -d)"
	printf '//registry.npmjs.org/:_authToken=%s\n' "$token" >"$tmp/.npmrc"
	trap 'rm -rf "$tmp"' EXIT
	npm publish "$tarball" --userconfig="$tmp/.npmrc"
else
	npm publish "$tarball"
fi

echo
echo "publish: staged/live as reef-code@$version"
echo "publish: if it did not appear, approve it at https://www.npmjs.com/package/reef-code/staged"
