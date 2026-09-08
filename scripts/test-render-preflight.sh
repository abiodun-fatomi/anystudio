#!/usr/bin/env bash
set -euo pipefail

# Exercise Render's actual Retrieve Service nesting without network access.
# This catches a dangerous false negative where the release gate rejects a
# correctly configured service because a field was read from the wrong level.
fixture_dir="$(mktemp -d)"
trap 'rm -rf "$fixture_dir"' EXIT

cat >"$fixture_dir/curl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
url="${!#}"
service() {
  local name="$1" type="$2" plan="$3" instances="$4" command="$5" predeploy="$6"
  jq -n \
    --arg name "$name" --arg type "$type" --arg plan "$plan" \
    --argjson instances "$instances" --arg command "$command" --arg predeploy "$predeploy" \
    '{ownerId:"own_fixture",name:$name,type:$type,branch:"development",repo:"https://github.com/owner/repo.git",autoDeploy:false,
      serviceDetails:{runtime:"docker",plan:$plan,region:"frankfurt",numInstances:$instances,maxShutdownDelaySeconds:300,
        preDeployCommand:$predeploy,envSpecificDetails:{dockerfilePath:"./apps/api/Dockerfile",dockerContext:".",dockerCommand:$command}}}'
}
envs() {
  case "$1" in
    api) jq -n '[{key:"SERVICE_NAME",value:"api"},{key:"APP_ENV",value:"dev"},{key:"NODE_ENV",value:"production"}]' ;;
    worker) jq -n '[{key:"SERVICE_NAME",value:"worker"},{key:"APP_ENV",value:"dev"},{key:"NODE_ENV",value:"production"},{key:"WORKER_QUEUES",value:"media.fast,media.heavy"},{key:"NODE_OPTIONS",value:"--max-old-space-size=384"},{key:"FFMPEG_CONCURRENCY",value:"1"},{key:"WORKER_FAST_CONCURRENCY",value:"6"},{key:"WORKER_HEAVY_CONCURRENCY",value:"8"}]' ;;
    media) jq -n '[{key:"SERVICE_NAME",value:"media"},{key:"APP_ENV",value:"dev"},{key:"NODE_ENV",value:"production"},{key:"WORKER_QUEUES",value:"media.local"},{key:"NODE_OPTIONS",value:"--max-old-space-size=1024"},{key:"FFMPEG_CONCURRENCY",value:"1"},{key:"WORKER_LOCAL_CONCURRENCY",value:"1"},{key:"WORKER_DIRECT_CONCURRENCY",value:"1"}]' ;;
  esac
}
case "$url" in
  */services/api) service anystudio-api-dev web_service 0.5c-512mb 1 '' 'npm run release' ;;
  */services/worker) service anystudio-worker-dev background_worker 0.5c-512mb 1 'node dist/src/worker/main.js' '' ;;
  */services/media) service anystudio-media-dev background_worker 1c-2g 1 'node dist/src/worker/main.js' '' ;;
  */services/api/env-vars*) envs api ;;
  */services/worker/env-vars*) envs worker ;;
  */services/media/env-vars*) envs media ;;
  */blueprints/validate) jq -n '{valid:true}' ;;
  *) echo "unexpected fixture URL: $url" >&2; exit 1 ;;
esac
SH
chmod +x "$fixture_dir/curl"

PATH="$fixture_dir:$PATH" RENDER_API_KEY=fixture bash scripts/render-preflight.sh development owner/repo api worker media >/dev/null

echo '✔ Render live preflight reads the official service response field layout'
