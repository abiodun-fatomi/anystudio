#!/usr/bin/env bash
# Download the auth-page showcase assets into apps/web/public/shots/.
# Source of truth for what these are: design/assets.json. Run once, commit the
# files — they are small, and the page must not depend on a third-party CDN.
# (Plain arrays only: macOS ships bash 3.2, which has no associative arrays.)
set -euo pipefail
cd "$(dirname "$0")/../apps/web/public"
mkdir -p shots
base="https://d8j0ntlcm91z4.cloudfront.net/user_3IddmXNLbq9Xe4BGGivqigdHdE9"
files=(
  "source.webp      hf_20260901_100709_af7b22ca-c2ab-4a47-919e-f74db1df3fd6_min.webp"
  "ravi-1.webp      hf_20260901_100625_ac6a5163-9b02-4749-9aa1-88ef4f99309e_min.webp"
  "ravi-2.webp      hf_20260901_100709_76c9dda3-bd71-4133-b679-5031d24d6c4a_min.webp"
  "bimbo.webp       hf_20260901_100741_ee51b3da-93f1-4d8c-9749-0d518372e22c_min.webp"
  "kicks.webp       hf_20260901_100741_6980c8b9-bdb8-4b35-83f5-bc5feb14156d_min.webp"
  "reel-poster.webp hf_20260901_142549_01b19572-d291-437d-99a7-d01c6befb98f_min.webp"
  "reel.mp4         hf_20260902_033722_f9f7dd64-220a-473f-badd-63c368e00511.mp4"
)
for entry in "${files[@]}"; do
  set -- $entry
  echo "→ shots/$1"
  curl -fsSL --retry 3 -o "shots/$1" "$base/$2"
done
ls -la shots
