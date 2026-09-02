#!/usr/bin/env bash
# Download the showcase media listed in scripts/shots.json into
# apps/web/public/shots/. Run once, commit the files — they are small, and
# the pages must not depend on a third-party CDN. Needs node and curl.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p apps/web/public/shots
base=$(node -p 'require("./scripts/shots.json").base')
node -e 'const f=require("./scripts/shots.json").files; for (const k in f) console.log(k, f[k])' |
while read -r name src; do
  if [ -s "apps/web/public/shots/$name" ]; then echo "= shots/$name (have it)"; continue; fi
  echo "→ shots/$name"
  curl -fsSL --retry 3 -o "apps/web/public/shots/$name" "$base/$src"
done
ls -la apps/web/public/shots
