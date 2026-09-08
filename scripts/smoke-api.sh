#!/usr/bin/env bash
# Prove a deployed API is the commit we think it is, and can serve traffic.
#
#   scripts/smoke-api.sh https://api.dev.anystudio.ai <commit-sha>
#
# /health answers from the API process alone and carries `release` (the short
# git sha it was built from). /ready answers only once the database does and
# both queue workers have checked in; their non-sensitive release ids prove
# that the fast/heavy and local-media services also run this exact commit.
# Both calls go through Cloudflare, so this also catches a DNS or certificate
# problem that Render's own web-service health check cannot see.
#
# Retries beyond the five-minute graceful-shutdown ceiling: after "live" the
# old worker may still be draining and writing its older release heartbeat,
# and the proxy's cache of a 502 also takes a moment to clear.

set -euo pipefail

BASE="${1:?usage: $0 <api-base-url> <commit-sha>}"
COMMIT="${2:?usage: $0 <api-base-url> <commit-sha>}"
BASE="${BASE%/}"
WANT="${COMMIT:0:7}"
ATTEMPTS="${SMOKE_ATTEMPTS:-42}"
SLEEP="${SMOKE_SLEEP:-10}"

for i in $(seq 1 "$ATTEMPTS"); do
  health="$(curl -sS --max-time 10 "$BASE/health" || true)"
  release="$(jq -r '.data.release // .release // empty' <<<"$health" 2>/dev/null || true)"
  if [ "$release" = "$WANT" ]; then
    ready="$(curl -sS --max-time 10 "$BASE/ready" || true)"
    status="$(jq -r '.data.status // .status // empty' <<<"$ready" 2>/dev/null || true)"
    worker_alive="$(jq -r '.data.workers.worker.alive // .workers.worker.alive // false' <<<"$ready" 2>/dev/null || true)"
    worker_release="$(jq -r '.data.workers.worker.release // .workers.worker.release // empty' <<<"$ready" 2>/dev/null || true)"
    media_alive="$(jq -r '.data.workers.media.alive // .workers.media.alive // false' <<<"$ready" 2>/dev/null || true)"
    media_release="$(jq -r '.data.workers.media.release // .workers.media.release // empty' <<<"$ready" 2>/dev/null || true)"
    if [ "$status" = "ready" ] && [ "$worker_alive" = "true" ] && [ "$worker_release" = "$WANT" ] && \
       [ "$media_alive" = "true" ] && [ "$media_release" = "$WANT" ]; then
      echo "✔ $BASE, worker and media are serving $WANT; the database answers"
      exit 0
    fi
    echo "  $i/$ATTEMPTS: API=$WANT ready=${status:-nothing} worker=${worker_alive:-false}/${worker_release:-none} media=${media_alive:-false}/${media_release:-none} — waiting"
  else
    echo "  $i/$ATTEMPTS: /health reports '${release:-nothing}', want $WANT — waiting"
  fi
  sleep "$SLEEP"
done

echo "::error::$BASE never reported API, worker and media release $WANT with a ready database. Last /health: ${health:-<no response>}. Last /ready: ${ready:-<no response>}"
exit 1
