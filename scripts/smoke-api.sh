#!/usr/bin/env bash
# Prove a deployed API is the commit we think it is, and can serve traffic.
#
#   scripts/smoke-api.sh https://api.dev.anystudio.ai <commit-sha>
#
# /health answers from the process alone and carries `release` (the short
# git sha it was built from); /ready answers only once the database does.
# Both go through Cloudflare, so this also catches a DNS or certificate
# problem that Render's own health check, which talks to the origin
# directly, cannot see.
#
# Retries for a couple of minutes: after "live" the old instance may still be
# draining, and the proxy's cache of a 502 takes a moment to clear.

set -euo pipefail

BASE="${1:?usage: $0 <api-base-url> <commit-sha>}"
COMMIT="${2:?usage: $0 <api-base-url> <commit-sha>}"
BASE="${BASE%/}"
WANT="${COMMIT:0:7}"
ATTEMPTS="${SMOKE_ATTEMPTS:-12}"
SLEEP="${SMOKE_SLEEP:-10}"

for i in $(seq 1 "$ATTEMPTS"); do
  health="$(curl -sS --max-time 10 "$BASE/health" || true)"
  release="$(jq -r '.data.release // .release // empty' <<<"$health" 2>/dev/null || true)"
  if [ "$release" = "$WANT" ]; then
    ready="$(curl -sS --max-time 10 "$BASE/ready" || true)"
    status="$(jq -r '.data.status // .status // empty' <<<"$ready" 2>/dev/null || true)"
    if [ "$status" = "ready" ]; then
      echo "✔ $BASE is serving $WANT and its database answers"
      exit 0
    fi
    echo "  $i/$ATTEMPTS: $WANT is up but /ready says '${status:-nothing}' — waiting"
  else
    echo "  $i/$ATTEMPTS: /health reports '${release:-nothing}', want $WANT — waiting"
  fi
  sleep "$SLEEP"
done

echo "::error::$BASE never reported release $WANT with a ready database. Last /health: ${health:-<no response>}"
exit 1
