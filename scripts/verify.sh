#!/usr/bin/env bash
# Platform verify command: bash scripts/verify.sh (run from the repo root).
# Exits non-zero when anything is wrong; the deploy loop rolls back on failure.
set -euo pipefail
cd "$(dirname "$0")/.."

fail=0

# Showcase content check (the previous verify_cmd).
if [ -e scripts/verify-showcase.sh ]; then
  if bash scripts/verify-showcase.sh; then
    echo "PASS: bash scripts/verify-showcase.sh exits 0"
  else
    echo "FAIL: bash scripts/verify-showcase.sh exits non-zero"; fail=1
  fi
else
  echo "scripts/verify-showcase.sh not present yet, skipping"
fi

# Python environment created by deploy.sh.
if .venv/bin/python -c "import json, venv" 2>/dev/null; then
  echo "PASS: .venv/bin/python works"
else
  echo "FAIL: .venv/bin/python missing or broken"; fail=1
fi

# No AWS account id in committed files (lock files carry integrity hashes).
hits=$(git grep -nE '[0-9]{12}' -- . ':(exclude)**/package-lock.json' || true)
if [ -z "$hits" ]; then
  echo "PASS: git grep -nE [0-9]{12} finds no AWS account id in committed files (package-lock.json excluded)"
else
  echo "FAIL: git grep -nE [0-9]{12} hits: $(printf '%s\n' "$hits" | cut -d: -f1,2 | paste -sd' ' -)"; fail=1
fi

# Stack status, only when deploy.sh deployed the infra (AGP_DEPLOY_INFRA=1).
if [ "${AGP_DEPLOY_INFRA:-0}" = "1" ]; then
  cfg=config.json; [ -f "$cfg" ] || cfg=config.example.json
  region=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['region'])" "$cfg")
  status=$(aws cloudformation describe-stacks --stack-name AppStreamOmniverseStack --region "$region" \
    --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo MISSING)
  case "$status" in
    CREATE_COMPLETE|UPDATE_COMPLETE) echo "PASS: AppStreamOmniverseStack $status" ;;
    *) echo "FAIL: AppStreamOmniverseStack status $status"; fail=1 ;;
  esac
fi

[ "$fail" -eq 0 ] && echo "verify.sh passed"
exit "$fail"
