#!/usr/bin/env bash
# Platform tear-down command: bash scripts/destroy.sh (run from the repo root).
#
# The platform assumes the deploy role and exports AWS_REGION before calling this,
# so the script never assumes a role, picks a region or reads a profile.
# stdout carries one record per line for the platform's parser:
#   REMOVED <stack-name>
#   LEFTOVER <resource-type> <physical-id>
#   remaining: <stack-name> <status>
# Everything else goes to stderr. Host units and .venv are not touched.
set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT=appstream-omniverse
log() { echo "$*" >&2; }

if [ ! -d infra ]; then
  log "No infra/ folder: nothing to destroy"
  exit 0
fi

# The owner deploys and destroys this demo by hand (docs/project.md); mirror deploy.sh.
if [ "${AGP_DEPLOY_INFRA:-0}" != "1" ]; then
  log "Skipping destroy: this demo is deployed and destroyed by the owner (docs/deploy-runbook.md Clean Up); set AGP_DEPLOY_INFRA=1 to override"
  exit 0
fi

cfg=config.json; [ -f "$cfg" ] || cfg=config.example.json
cfg_get() {
  python3 -c "import json,sys
v=json.load(open(sys.argv[1]))
for k in sys.argv[2].split('.'): v=v.get(k, '') if isinstance(v, dict) else ''
print(str(v).lower() if isinstance(v, bool) else v)" "$cfg" "$1"
}
IMAGE_NAME=$(cfg_get image.customImageName)
NUCLEUS_ENABLED=$(cfg_get nucleus.enabled)
CFG_PROJECT=$(cfg_get projectName); CFG_PROJECT=${CFG_PROJECT:-$PROJECT}

cd infra
[ -d node_modules ] || npm ci >&2

mapfile -t STACKS < <(npx cdk ls 2>/dev/null | awk 'NF')
# Fall back to the stack defined in infra/bin/app.ts when synth fails (e.g. no config.json).
[ "${#STACKS[@]}" -gt 0 ] || STACKS=(AppStreamOmniverseStack)
log "Targeted stacks: ${STACKS[*]:-none}"

stack_status() {
  local out
  if out=$(aws cloudformation describe-stacks --stack-name "$1" \
      --query 'Stacks[0].StackStatus' --output text 2>&1); then
    echo "$out"
  elif grep -q "does not exist" <<<"$out"; then
    echo "GONE"
  else
    log "describe-stacks $1 failed: $out"
    echo "UNKNOWN"
  fi
}

# An AppStream fleet must be stopped before it can be deleted: stop any in the stacks.
for stack in "${STACKS[@]}"; do
  [ "$(stack_status "$stack")" = "GONE" ] && continue
  for fleet in $(aws cloudformation describe-stack-resources --stack-name "$stack" \
      --query "StackResources[?ResourceType=='AWS::AppStream::Fleet'].PhysicalResourceId" \
      --output text 2>/dev/null || true); do
    state=$(aws appstream describe-fleets --names "$fleet" \
      --query 'Fleets[0].State' --output text 2>/dev/null || echo "")
    if [ "$state" = "RUNNING" ] || [ "$state" = "STARTING" ]; then
      log "Stopping fleet $fleet ($state)"
      aws appstream stop-fleet --name "$fleet" >&2 || true
      for _ in $(seq 1 60); do
        state=$(aws appstream describe-fleets --names "$fleet" \
          --query 'Fleets[0].State' --output text 2>/dev/null || echo "")
        [ "$state" = "STOPPED" ] && break
        sleep 20
      done
    fi
  done
done

destroy_rc=0
npx cdk destroy --all --force >&2 || destroy_rc=$?
[ "$destroy_rc" -eq 0 ] || log "cdk destroy exited with $destroy_rc"

failed=0
for stack in "${STACKS[@]}"; do
  status=$(stack_status "$stack")
  case "$status" in
    GONE|DELETE_COMPLETE)
      echo "REMOVED $stack"
      ;;
    *)
      echo "remaining: $stack $status"
      failed=1
      # Resources a retain policy kept while deletion was in progress.
      aws cloudformation describe-stack-resources --stack-name "$stack" \
        --query "StackResources[?ResourceStatus=='DELETE_SKIPPED'].[ResourceType,PhysicalResourceId]" \
        --output text 2>/dev/null | awk 'NF==2 {print "LEFTOVER " $1 " " $2}' || true
      ;;
  esac
done

# Resources tagged for the project that outlived their stacks (retained buckets, log groups).
aws resourcegroupstaggingapi get-resources --tag-filters "Key=Project,Values=$PROJECT" \
  --query 'ResourceTagMappingList[].ResourceARN' --output text 2>/dev/null \
  | tr '\t' '\n' | awk 'NF' | while read -r arn; do
    # arn:aws:<service>:<region>:<account>:<resource>
    service=$(cut -d: -f3 <<<"$arn")
    resource=$(cut -d: -f6- <<<"$arn")
    type="${resource%%[/:]*}"
    [ "$type" = "$resource" ] && type=""
    echo "LEFTOVER ${service}${type:+:$type} $arn"
  done || true

# Manual clean-up items the stack never owned (README Clean Up, docs/deploy-runbook.md Step 9).
# Read-only describe calls only.
if [ -n "$IMAGE_NAME" ]; then
  aws appstream describe-images --names "$IMAGE_NAME" \
    --query 'Images[].Name' --output text 2>/dev/null \
    | tr '\t' '\n' | awk 'NF {print "LEFTOVER appstream:image " $1}' || true
  # prepare-ami.py names the AMI <project>-g6e-<ts> and the AppStream image omniverse-g6e-<ts>[-vN].
  ts=$(sed -nE 's/.*-g6e-([0-9]+)(-v[0-9]+)?$/\1/p' <<<"$IMAGE_NAME")
  if [ -n "$ts" ]; then
    aws ec2 describe-images --owners self --filters "Name=name,Values=${CFG_PROJECT}-g6e-${ts}" \
      --query 'Images[].[ImageId, join(`,`, BlockDeviceMappings[].Ebs.SnapshotId)]' \
      --output text 2>/dev/null | while read -r ami snaps; do
        [ -n "$ami" ] || continue
        echo "LEFTOVER ec2:image $ami"
        tr ',' '\n' <<<"$snaps" | awk 'NF && $1 != "None" {print "LEFTOVER ec2:snapshot " $1}'
      done || true
  fi
fi

# Nucleus secrets sit in a 7-day deletion window after the stack is gone.
if [ "$NUCLEUS_ENABLED" = "true" ]; then
  for secret in "$CFG_PROJECT/nucleus/admin" "$CFG_PROJECT/nucleus/service"; do
    arn=$(aws secretsmanager describe-secret --secret-id "$secret" \
      --query 'ARN' --output text 2>/dev/null || true)
    if [ -n "$arn" ] && [ "$arn" != "None" ]; then
      echo "LEFTOVER secretsmanager:secret $arn"
    fi
  done
fi

exit "$failed"
