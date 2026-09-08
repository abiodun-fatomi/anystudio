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
  local auto_deploy='"no"'
  if [ -z "${AUTO_DEPLOY_ROLE:-}" ] || [ "$name" = "anystudio-${AUTO_DEPLOY_ROLE}-dev" ]; then
    auto_deploy="${AUTO_DEPLOY_JSON:-\"no\"}"
  fi
  jq -n \
    --arg name "$name" --arg type "$type" --arg plan "$plan" \
    --argjson autoDeploy "$auto_deploy" \
    --argjson instances "$instances" --arg command "$command" --arg predeploy "$predeploy" \
    '{ownerId:"own_fixture",name:$name,type:$type,branch:"development",repo:"https://github.com/owner/repo.git",autoDeploy:$autoDeploy,
      serviceDetails:{runtime:"docker",plan:$plan,region:"frankfurt",numInstances:$instances,maxShutdownDelaySeconds:300,
        envSpecificDetails:{preDeployCommand:$predeploy,dockerfilePath:"./apps/api/Dockerfile",dockerContext:".",dockerCommand:$command}}}
      | if env.OMIT_AUTO_DEPLOY == "1" then del(.autoDeploy) else . end
      | if $name == "anystudio-api-dev" then
          if env.PREDEPLOY_CASE == "missing" then del(.serviceDetails.envSpecificDetails.preDeployCommand)
          elif env.PREDEPLOY_CASE == "blank" then .serviceDetails.envSpecificDetails.preDeployCommand = ""
          elif env.PREDEPLOY_CASE == "wrong" then .serviceDetails.envSpecificDetails.preDeployCommand = "npm run start"
          elif env.PREDEPLOY_CASE == "write-shape-only" then
            .serviceDetails.preDeployCommand = $predeploy | del(.serviceDetails.envSpecificDetails.preDeployCommand)
          else . end
        elif env.PREDEPLOY_CASE == "worker-release" and $name == "anystudio-worker-dev" then
          .serviceDetails.envSpecificDetails.preDeployCommand = "npm run release"
        elif env.PREDEPLOY_CASE == "media-release" and $name == "anystudio-media-dev" then
          .serviceDetails.envSpecificDetails.preDeployCommand = "npm run release"
        else . end'
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

PATH="$fixture_dir:$PATH" RENDER_API_KEY=fixture AUTO_DEPLOY_JSON=false bash scripts/render-preflight.sh development owner/repo api worker media >/dev/null

# Do not weaken the release gate while accepting Render's real enum. Check
# each role so an unsafe worker cannot be hidden by a correctly configured API.
for role in api worker media; do
  for value in true '"yes"' null '"false"' '"off"' '""' 0; do
    if output="$(PATH="$fixture_dir:$PATH" RENDER_API_KEY=fixture AUTO_DEPLOY_ROLE="$role" AUTO_DEPLOY_JSON="$value" bash scripts/render-preflight.sh development owner/repo api worker media 2>&1)"; then
      echo "Expected $role autoDeploy=$value to fail" >&2
      exit 1
    fi
    [[ "$output" == *"Render $role service has autoDeploy="* ]] || { echo "Failed for the wrong reason: $output" >&2; exit 1; }
  done
done
if output="$(PATH="$fixture_dir:$PATH" RENDER_API_KEY=fixture OMIT_AUTO_DEPLOY=1 bash scripts/render-preflight.sh development owner/repo api worker media 2>&1)"; then
  echo 'Expected missing autoDeploy to fail' >&2
  exit 1
fi
[[ "$output" == *'Render api service has autoDeploy='* ]] || { echo "Failed for the wrong reason: $output" >&2; exit 1; }

echo '✔ Render live preflight reads the official service response field layout'
echo '✔ autoDeploy accepts no/false and rejects enabled, missing and unknown values'

for scenario in missing blank wrong write-shape-only worker-release media-release; do
  role=api
  [ "$scenario" != worker-release ] || role=worker
  [ "$scenario" != media-release ] || role=media
  if output="$(PATH="$fixture_dir:$PATH" RENDER_API_KEY=fixture PREDEPLOY_CASE="$scenario" bash scripts/render-preflight.sh development owner/repo api worker media 2>&1)"; then
    echo "Expected pre-deploy scenario $scenario to fail" >&2
    exit 1
  fi
  [[ "$output" == *"Render $role service has preDeployCommand="* ]] || { echo "Failed for the wrong reason: $output" >&2; exit 1; }
done
echo '✔ pre-deploy reads Docker response nesting, requires API release and rejects worker release commands'
