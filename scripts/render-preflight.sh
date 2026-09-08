#!/usr/bin/env bash
# Fail closed before mutating Render. The three IDs must be distinct services
# from this repo/environment, with the worker commands and queue boundaries
# the release depends on.
#
#   RENDER_API_KEY=rnd_... scripts/render-preflight.sh \
#     development owner/repo <api-srv> <worker-srv> <media-srv>

set -euo pipefail

ENVIRONMENT="${1:-}"
EXPECTED_REPO="${2:-}"
API_ID="${3:-}"
WORKER_ID="${4:-}"
MEDIA_ID="${5:-}"
OWNER_ID=""

if [ -z "$ENVIRONMENT" ] || [ -z "$EXPECTED_REPO" ] || [ -z "$API_ID" ] || [ -z "$WORKER_ID" ] || [ -z "$MEDIA_ID" ]; then
  echo "usage: $0 <development|staging|production> <owner/repo> <api-id> <worker-id> <media-id>" >&2
  exit 3
fi
if [ -z "${RENDER_API_KEY:-}" ]; then
  echo "RENDER_API_KEY is not set" >&2
  exit 3
fi
if [ "$API_ID" = "$WORKER_ID" ] || [ "$API_ID" = "$MEDIA_ID" ] || [ "$WORKER_ID" = "$MEDIA_ID" ]; then
  echo "::error::RENDER_API_SERVICE_ID, RENDER_WORKER_SERVICE_ID and RENDER_MEDIA_SERVICE_ID must identify three distinct Render services."
  exit 1
fi

case "$ENVIRONMENT" in
  development)
    SUFFIX=-dev
    EXPECTED_APP_ENV=dev
    EXPECTED_API_PLAN=0.5c-512mb
    EXPECTED_API_INSTANCES=1
    EXPECTED_WORKER_PLAN=0.5c-512mb
    EXPECTED_WORKER_NODE_OPTIONS=--max-old-space-size=384
    EXPECTED_WORKER_FAST_CONCURRENCY=6
    EXPECTED_WORKER_HEAVY_CONCURRENCY=8
    ;;
  staging)
    SUFFIX=-staging
    EXPECTED_APP_ENV=staging
    EXPECTED_API_PLAN=0.5c-512mb
    EXPECTED_API_INSTANCES=1
    EXPECTED_WORKER_PLAN=0.5c-512mb
    EXPECTED_WORKER_NODE_OPTIONS=--max-old-space-size=384
    EXPECTED_WORKER_FAST_CONCURRENCY=6
    EXPECTED_WORKER_HEAVY_CONCURRENCY=8
    ;;
  production)
    SUFFIX=
    EXPECTED_APP_ENV=production
    EXPECTED_API_PLAN=1c-2g
    EXPECTED_API_INSTANCES=2
    EXPECTED_WORKER_PLAN=1c-2g
    EXPECTED_WORKER_NODE_OPTIONS=--max-old-space-size=1536
    EXPECTED_WORKER_FAST_CONCURRENCY=12
    EXPECTED_WORKER_HEAVY_CONCURRENCY=16
    ;;
  *) echo "::error::Unsupported deployment environment '$ENVIRONMENT'."; exit 3 ;;
esac

EXPECTED_REGION=frankfurt
EXPECTED_WORKER_INSTANCES=1
EXPECTED_MEDIA_PLAN=1c-2g
EXPECTED_MEDIA_INSTANCES=1
EXPECTED_MEDIA_NODE_OPTIONS=--max-old-space-size=1024
EXPECTED_DOCKERFILE_PATH=./apps/api/Dockerfile
EXPECTED_DOCKER_CONTEXT=.
EXPECTED_MAX_SHUTDOWN_DELAY=300
EXPECTED_API_PRE_DEPLOY='npm run release'

api() {
  curl -fsS --retry 3 --retry-delay 2 \
    -H "Authorization: Bearer $RENDER_API_KEY" \
    -H "Accept: application/json" \
    "$@"
}

fail() {
  local role="$1" field="$2" expected="$3" actual="$4"
  echo "::error::Render $role service has $field='$actual'; expected '$expected' for '$ENVIRONMENT'. Fix the GitHub environment service ID or the Render service setting before deploying."
  exit 1
}

normalise_repo() {
  local repo="$1"
  repo="${repo%.git}"
  repo="${repo#https://github.com/}"
  repo="${repo#git@github.com:}"
  printf '%s' "$repo" | tr '[:upper:]' '[:lower:]'
}

env_value() {
  local json="$1" key="$2"
  jq -r --arg key "$key" '[.[] | (.envVar // .) | select(.key == $key) | .value][0] // empty' <<<"$json"
}

check_service() {
  local role="$1" id="$2" expected_name="$3" expected_type="$4" expected_command="$5" expected_service_name="$6" expected_queues="$7"
  local expected_plan expected_instances expected_shutdown expected_pre_deploy expected_node_options
  local service envs actual

  case "$role" in
    api)
      expected_plan="$EXPECTED_API_PLAN"
      expected_instances="$EXPECTED_API_INSTANCES"
      expected_shutdown=""
      expected_pre_deploy="$EXPECTED_API_PRE_DEPLOY"
      expected_node_options=""
      ;;
    worker)
      expected_plan="$EXPECTED_WORKER_PLAN"
      expected_instances="$EXPECTED_WORKER_INSTANCES"
      expected_shutdown="$EXPECTED_MAX_SHUTDOWN_DELAY"
      expected_pre_deploy=""
      expected_node_options="$EXPECTED_WORKER_NODE_OPTIONS"
      ;;
    media)
      expected_plan="$EXPECTED_MEDIA_PLAN"
      expected_instances="$EXPECTED_MEDIA_INSTANCES"
      expected_shutdown="$EXPECTED_MAX_SHUTDOWN_DELAY"
      expected_pre_deploy=""
      expected_node_options="$EXPECTED_MEDIA_NODE_OPTIONS"
      ;;
    *)
      echo "::error::Unknown Render service role '$role'."
      exit 3
      ;;
  esac

  service="$(api "https://api.render.com/v1/services/$id")"

  actual="$(jq -r '.ownerId // empty' <<<"$service")"
  if [ -z "$OWNER_ID" ]; then
    OWNER_ID="$actual"
  elif [ "$actual" != "$OWNER_ID" ]; then
    fail "$role" ownerId "$OWNER_ID" "$actual"
  fi

  actual="$(jq -r '.name // empty' <<<"$service")"
  [ "$actual" = "$expected_name" ] || fail "$role" name "$expected_name" "$actual"
  actual="$(jq -r '.type // empty' <<<"$service")"
  [ "$actual" = "$expected_type" ] || fail "$role" type "$expected_type" "$actual"
  actual="$(jq -r '.branch // empty' <<<"$service")"
  [ "$actual" = "$ENVIRONMENT" ] || fail "$role" branch "$ENVIRONMENT" "$actual"
  actual="$(normalise_repo "$(jq -r '.repo // empty' <<<"$service")")"
  [ "$actual" = "$(normalise_repo "$EXPECTED_REPO")" ] || fail "$role" repo "$EXPECTED_REPO" "$actual"
  actual="$(jq -r '.autoDeploy | tostring' <<<"$service")"
  # The REST API returns the yes/no enum; some service representations use
  # booleans. Both explicit disabled values are safe. Missing/unknown values
  # must never be treated as disabled (jq's // also replaces false).
  jq -e '(.autoDeploy == "no") or (.autoDeploy == false)' <<<"$service" >/dev/null \
    || fail "$role" autoDeploy 'no (or boolean false)' "$actual"
  actual="$(jq -r '.serviceDetails.runtime // empty' <<<"$service")"
  [ "$actual" = "docker" ] || fail "$role" runtime docker "$actual"

  # Render's Retrieve service schema keeps capacity fields on serviceDetails
  # and Docker build/run fields one level deeper on envSpecificDetails. Do
  # not fall back to Blueprint values here: this gate must attest live state.
  actual="$(jq -r '.serviceDetails.plan // empty' <<<"$service")"
  [ "$actual" = "$expected_plan" ] || fail "$role" plan "$expected_plan" "$actual"
  actual="$(jq -r '.serviceDetails.region // empty' <<<"$service")"
  [ "$actual" = "$EXPECTED_REGION" ] || fail "$role" region "$EXPECTED_REGION" "$actual"
  actual="$(jq -r '.serviceDetails.numInstances // empty | tostring' <<<"$service")"
  [ "$actual" = "$expected_instances" ] || fail "$role" numInstances "$expected_instances" "$actual"

  actual="$(jq -r '.serviceDetails.envSpecificDetails.dockerfilePath // empty' <<<"$service")"
  [ "$actual" = "$EXPECTED_DOCKERFILE_PATH" ] || fail "$role" dockerfilePath "$EXPECTED_DOCKERFILE_PATH" "$actual"
  actual="$(jq -r '.serviceDetails.envSpecificDetails.dockerContext // empty' <<<"$service")"
  [ "$actual" = "$EXPECTED_DOCKER_CONTEXT" ] || fail "$role" dockerContext "$EXPECTED_DOCKER_CONTEXT" "$actual"
  actual="$(jq -r '.serviceDetails.envSpecificDetails.dockerCommand // empty' <<<"$service")"
  [ "$actual" = "$expected_command" ] || fail "$role" dockerCommand "${expected_command:-<Dockerfile CMD>}" "${actual:-<Dockerfile CMD>}"
  actual="$(jq -r '.serviceDetails.preDeployCommand // empty' <<<"$service")"
  [ "$actual" = "$expected_pre_deploy" ] || fail "$role" preDeployCommand "${expected_pre_deploy:-<unset>}" "${actual:-<unset>}"
  if [ -n "$expected_shutdown" ]; then
    actual="$(jq -r '.serviceDetails.maxShutdownDelaySeconds // empty | tostring' <<<"$service")"
    [ "$actual" = "$expected_shutdown" ] || fail "$role" maxShutdownDelaySeconds "$expected_shutdown" "$actual"
  fi

  # This endpoint returns direct service variables only; linked secret-group
  # values are intentionally neither read nor printed.
  envs="$(api "https://api.render.com/v1/services/$id/env-vars?limit=100")"
  actual="$(env_value "$envs" SERVICE_NAME)"
  [ "$actual" = "$expected_service_name" ] || fail "$role" SERVICE_NAME "$expected_service_name" "$actual"
  actual="$(env_value "$envs" APP_ENV)"
  [ "$actual" = "$EXPECTED_APP_ENV" ] || fail "$role" APP_ENV "$EXPECTED_APP_ENV" "$actual"
  actual="$(env_value "$envs" NODE_ENV)"
  [ "$actual" = "production" ] || fail "$role" NODE_ENV production "$actual"
  actual="$(env_value "$envs" WORKER_QUEUES)"
  [ "$actual" = "$expected_queues" ] || fail "$role" WORKER_QUEUES "${expected_queues:-<unset>}" "${actual:-<unset>}"
  if [ "$role" = "worker" ] || [ "$role" = "media" ]; then
    actual="$(env_value "$envs" NODE_OPTIONS)"
    [ "$actual" = "$expected_node_options" ] || fail "$role" NODE_OPTIONS "$expected_node_options" "$actual"
    actual="$(env_value "$envs" FFMPEG_CONCURRENCY)"
    [ "$actual" = "1" ] || fail "$role" FFMPEG_CONCURRENCY 1 "$actual"
  fi
  if [ "$role" = "worker" ]; then
    actual="$(env_value "$envs" WORKER_FAST_CONCURRENCY)"
    [ "$actual" = "$EXPECTED_WORKER_FAST_CONCURRENCY" ] || fail "$role" WORKER_FAST_CONCURRENCY "$EXPECTED_WORKER_FAST_CONCURRENCY" "$actual"
    actual="$(env_value "$envs" WORKER_HEAVY_CONCURRENCY)"
    [ "$actual" = "$EXPECTED_WORKER_HEAVY_CONCURRENCY" ] || fail "$role" WORKER_HEAVY_CONCURRENCY "$EXPECTED_WORKER_HEAVY_CONCURRENCY" "$actual"
  fi
  if [ "$role" = "media" ]; then
    actual="$(env_value "$envs" WORKER_LOCAL_CONCURRENCY)"
    [ "$actual" = "1" ] || fail "$role" WORKER_LOCAL_CONCURRENCY 1 "$actual"
    actual="$(env_value "$envs" WORKER_DIRECT_CONCURRENCY)"
    [ "$actual" = "1" ] || fail "$role" WORKER_DIRECT_CONCURRENCY 1 "$actual"
  fi

  echo "✔ Render $role: $expected_name ($id), $expected_type, branch $ENVIRONMENT"
}

check_service api "$API_ID" "anystudio-api$SUFFIX" web_service "" api ""
check_service worker "$WORKER_ID" "anystudio-worker$SUFFIX" background_worker "node dist/src/worker/main.js" worker "media.fast,media.heavy"
check_service media "$MEDIA_ID" "anystudio-media$SUFFIX" background_worker "node dist/src/worker/main.js" media "media.local"

case "$ENVIRONMENT" in
  development) BLUEPRINT_FILE=render.yaml ;;
  staging) BLUEPRINT_FILE=render.staging.yaml ;;
  production) BLUEPRINT_FILE=render.production.yaml ;;
esac
if [ ! -f "$BLUEPRINT_FILE" ]; then
  echo "::error::Expected deployment Blueprint '$BLUEPRINT_FILE' is missing."
  exit 1
fi
# Render's own validator checks the exact environment Blueprint without
# syncing it or changing a resource. It also catches a missing manually
# managed fromGroup before the first service deployment. The endpoint returns
# HTTP 200 for both valid and invalid files, so the JSON `valid` flag is the
# release gate; curl success alone is not enough.
validation="$(api -X POST \
  -F "ownerId=$OWNER_ID" \
  -F "file=@$BLUEPRINT_FILE;type=application/yaml" \
  "https://api.render.com/v1/blueprints/validate")"
if [ "$(jq -r '.valid // false' <<<"$validation")" != "true" ]; then
  error_count="$(jq -r '(.errors // .validationErrors // []) | if type == "array" then length else 1 end' <<<"$validation")"
  echo "::error::Render rejected $BLUEPRINT_FILE ($error_count validation error(s)). Run 'render blueprints validate $BLUEPRINT_FILE' against the $ENVIRONMENT workspace and fix every reported field before deploying."
  exit 1
fi
echo "✔ Render accepted $BLUEPRINT_FILE for workspace $OWNER_ID"

echo "✔ Render deployment contract is complete and all three service IDs are distinct"
