#!/usr/bin/env bash
# Deploy one Render service at an exact commit and wait until it is live.
#
#   RENDER_API_KEY=rnd_… scripts/render-deploy.sh <srv-id> <commit-sha>
#
# Why the API and not a deploy hook: a hook deploys "the latest commit on the
# branch", which is not necessarily the commit that just passed CI if two
# merges land close together. `commitId` pins it. And a hook returns as soon
# as the deploy is *queued*; this script returns when the deploy is *live* or
# fails the job when it is not, so a broken release is a red run on the
# commit and not a surprise in the dashboard an hour later.
#
# Exit codes: 0 live, 1 failed/cancelled, 2 timed out, 3 bad input.

set -euo pipefail

SERVICE_ID="${1:-}"
COMMIT="${2:-}"
TIMEOUT_SECONDS="${RENDER_DEPLOY_TIMEOUT:-1200}"   # 20 min: a cold Docker build
POLL_SECONDS=15

if [ -z "$SERVICE_ID" ] || [ -z "$COMMIT" ]; then
  echo "usage: $0 <render-service-id> <commit-sha>" >&2
  exit 3
fi
if [ -z "${RENDER_API_KEY:-}" ]; then
  echo "RENDER_API_KEY is not set" >&2
  exit 3
fi

api() {
  curl -fsS --retry 3 --retry-delay 2 \
    -H "Authorization: Bearer $RENDER_API_KEY" \
    -H "Accept: application/json" \
    -H "Content-Type: application/json" \
    "$@"
}

SERVICE_JSON="$(api "https://api.render.com/v1/services/$SERVICE_ID")"
SERVICE_NAME="$(jq -r '.name' <<<"$SERVICE_JSON")"
DASHBOARD="$(jq -r '.dashboardUrl // empty' <<<"$SERVICE_JSON")"
echo "▶ $SERVICE_NAME ($SERVICE_ID) ← ${COMMIT:0:7}"

DEPLOY_JSON="$(api -X POST "https://api.render.com/v1/services/$SERVICE_ID/deploys" \
  -d "$(jq -cn --arg c "$COMMIT" '{clearCache: "do_not_clear", commitId: $c}')")"
DEPLOY_ID="$(jq -r '.id' <<<"$DEPLOY_JSON")"
echo "  deploy $DEPLOY_ID queued${DASHBOARD:+ — $DASHBOARD/deploys/$DEPLOY_ID}"

deadline=$(( $(date +%s) + TIMEOUT_SECONDS ))
last=""
while :; do
  STATUS="$(api "https://api.render.com/v1/services/$SERVICE_ID/deploys/$DEPLOY_ID" | jq -r '.status')"
  if [ "$STATUS" != "$last" ]; then
    echo "  $(date -u +%H:%M:%S) $STATUS"
    last="$STATUS"
  fi
  case "$STATUS" in
    live)
      echo "✔ $SERVICE_NAME is live at ${COMMIT:0:7}"
      exit 0 ;;
    build_failed|update_failed|pre_deploy_failed|canceled|deactivated)
      echo "::error::$SERVICE_NAME deploy $DEPLOY_ID ended with '$STATUS'.${DASHBOARD:+ Logs: $DASHBOARD/deploys/$DEPLOY_ID}"
      exit 1 ;;
  esac
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "::error::$SERVICE_NAME deploy $DEPLOY_ID still '$STATUS' after ${TIMEOUT_SECONDS}s.${DASHBOARD:+ $DASHBOARD/deploys/$DEPLOY_ID}"
    exit 2
  fi
  sleep "$POLL_SECONDS"
done
