#!/usr/bin/env bash
# Showcase content check: docs/showcase.md, docs/showcase/*.png and launcher.json.
# Run from anywhere; prints one OK/FAIL line per check and exits non-zero on any failure.
set -euo pipefail
cd "$(dirname "$0")/.."

fail=0
ok() { echo "OK: $1"; }
ko() { echo "FAIL: $1"; fail=1; }

if [ -f docs/showcase.md ]; then
  ok "docs/showcase.md exists"
  for marker in 'tagline:' 'tags:' '## Story' '## Architecture'; do
    if grep -qF -- "$marker" docs/showcase.md; then
      ok "docs/showcase.md contains '$marker'"
    else
      ko "docs/showcase.md missing '$marker'"
    fi
  done
else
  ko "docs/showcase.md missing"
fi

if ls docs/showcase/*.png >/dev/null 2>&1; then
  ok "docs/showcase/ has at least one PNG"
else
  ko "docs/showcase/ has no PNG"
fi

if python3 -m json.tool launcher.json >/dev/null 2>&1; then
  ok "launcher.json is valid JSON"
else
  ko "launcher.json missing or invalid JSON"
fi

exit "$fail"
