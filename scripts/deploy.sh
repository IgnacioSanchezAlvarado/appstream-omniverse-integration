#!/usr/bin/env bash
# Platform deploy command: bash scripts/deploy.sh (run from the repo root).
#
# The CDK stack (GPU fleet, Nucleus EC2) is deployed by the owner by hand, following
# docs/deploy-runbook.md; docs/project.md says the platform never deploys this demo.
# So the infra step only runs when AGP_DEPLOY_INFRA=1 is set explicitly.
# The dashboard's runtime-config.json is written by the stack itself (BucketDeployment),
# and nothing is served from the host, so there are no systemd units or health URL here.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -d infra ] && [ "${AGP_DEPLOY_INFRA:-0}" = "1" ]; then
  : "${AGP_OUTPUTS_FILE:?AGP_OUTPUTS_FILE must be set by the deploy loop}"
  echo "Deploying CDK stacks (CDK_DEFAULT_REGION=${CDK_DEFAULT_REGION:-unset})"
  (cd infra && npm ci && npx cdk deploy --all --require-approval never --outputs-file "$AGP_OUTPUTS_FILE")
  python3 -m json.tool "$AGP_OUTPUTS_FILE" >/dev/null
else
  echo "Skipping CDK deploy: this demo is deployed by the owner (docs/deploy-runbook.md); set AGP_DEPLOY_INFRA=1 to override"
fi

# Python environment for repo scripts; dependencies only when the repo declares them.
[ -x .venv/bin/python ] || python3 -m venv .venv
if [ -f requirements.txt ]; then
  .venv/bin/python -m pip install --quiet -r requirements.txt
elif [ -f pyproject.toml ]; then
  .venv/bin/python -m pip install --quiet .
fi

echo "deploy.sh finished"
