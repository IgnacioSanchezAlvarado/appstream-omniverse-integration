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

exit "$failed"
