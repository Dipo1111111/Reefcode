#!/usr/bin/env bash
# The cache contract, checked against a real session.
#
# `docs/05` §4 says a request must be the previous request plus an appended suffix. The harness
# records that verdict per request; this script runs a three-turn session and fails when any
# request breaks the contract without a declared reason.
#
# Usage: scripts/contract-check.sh [turn-count]
set -uo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bin="$root/apps/reef/bin/reef"
turns="${1:-3}"

if [ ! -x "$bin" ]; then
	echo "contract-check: no launcher at $bin (run npm run build)" >&2
	exit 2
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
printf '{"name":"fixture","version":"1.2.3"}\n' >"$work/package.json"
echo "alpha" >"$work/a.txt"
echo "beta" >"$work/b.txt"

cd "$work" || exit 2
prompt="read package.json, then a.txt, then b.txt, then tell me the version in one word"
case "$turns" in
2) prompt="read package.json, then tell me the version in one word" ;;
1) prompt="say ok" ;;
esac

if ! REEF_TRACE=1 "$bin" -p "$prompt" --no-session >/dev/null 2>"$work/trace.txt"; then
	echo "contract-check: the session failed; see $work/trace.txt" >&2
	cat "$work/trace.txt" >&2
	exit 1
fi

requests="$(grep -c '^\[reef\] request' "$work/trace.txt" || true)"
violations="$(grep -c '^\[reef\] cache contract:' "$work/trace.txt" || true)"

if [ "$requests" -eq 0 ]; then
	echo "contract-check: no request audits recorded — instrumentation is not wired" >&2
	exit 1
fi

if [ "$violations" -ne 0 ]; then
	echo "contract-check: $violations cache-contract violation(s) across $requests request(s)" >&2
	grep '^\[reef\]' "$work/trace.txt" >&2
	exit 1
fi

echo "contract-check: $requests request(s), append-only throughout"
grep '^\[reef\] request' "$work/trace.txt"
