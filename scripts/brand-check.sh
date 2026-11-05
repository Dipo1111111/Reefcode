#!/usr/bin/env bash
# Fail when the product's own strings leak the substrate's name.
# docs/17 §6, ADR-015. Allow-list: paths that are evidence, licences, or the vendored tree itself.
set -uo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

fail=0
scan() {
  local label="$1"; shift
  local hits
  hits=$("$@" 2>/dev/null | grep -vE '(^|/)(NOTICE|LICENSE|vendor/PIN)' | grep -vE '^vendor/pi/' | grep -vE '^scripts/brand-check.sh:' || true)
  if [ -n "$hits" ]; then
    echo "brand-check: $label"
    echo "$hits"
    fail=1
  fi
}

# 1. Help text and error strings the user reads.
scan "help text mentions the substrate" \
  grep -rn 'AI coding assistant with read\|running inside pi\|pi\.dev' apps packages scripts 2>/dev/null

# 2. Our own docs must call the product REEF.
scan "wrong product name in docs" \
  grep -rn '\bPi\b' README.md docs specs 2>/dev/null

exit $fail
