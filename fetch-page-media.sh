#!/usr/bin/env bash
# Twenty-one files. Run from a NORMAL Mac terminal — both sandboxes block
# that CDN, which is why I could not download any of these or look at them.
#
#   bash fetch-page-media.sh "/path/to/AnyStudio/anystudio"
#
# FOUR SECTIONS, FOUR PRODUCTS, EACH WITH A REEL AND A UGC AD
# -----------------------------------------------------------
#   hero sheet      the hat      (already here; frame 06 becomes the UGC ad)
#   "Then it moves" the hat      (+ a price-drop reel, so both cards are one product)
#   scroll-scrub    the bottle   (a NEW coherent set — see below)
#   six-up          the vase
#   sign-in page    the baby toy (+ its two clips)
#
# Every set is generated the way the product itself works: ONE source photo,
# and every other frame derived from it as a reference image with the
# instruction to change only the surroundings. The old hair-oil frames were
# each generated independently, which is why two of them carried different
# printed labels — on the page that promises we never redraw your product.
#
# THE GARMENT PANEL
# -----------------
# The four cards under "Every picture on the right came from that one on the
# left" were each generated from a text prompt with no reference image, and
# the fourth prompt literally said "a freshly pressed white cotton shirt".
# That is why Pressed was a man's white shirt beside three shots of a green
# linen dress. All four are regenerated from the bed snapshot on the left.
# shot-source.webp does not change — it is the photo they all come from.

set -euo pipefail
REPO="${1:-$HOME/Documents/Business projects/AnyStudio/anystudio}"
DEST="$REPO/apps/web/public/shots"
B="https://d8j0ntlcm91z4.cloudfront.net/user_3IddmXNLbq9Xe4BGGivqigdHdE9"

mkdir -p "$DEST"
fetch() { printf '  → %-20s' "$1"; curl -fsSL --retry 3 -o "$DEST/$1" "$B/$2"; printf 'ok\n'; }

echo "Fetching into $DEST"

echo
echo "The garment — all four now derived from shot-source.webp"
fetch shot-model.webp   hf_20260907_151649_1f36283d-3e21-4a93-8ef1-50b00f6cc797_min.webp
fetch shot-ghost.webp   hf_20260907_151649_d2c672f6-8caa-4d38-80b7-79135354b089_min.webp
fetch shot-flat.webp    hf_20260907_151649_0a468ea2-de12-4dbe-907d-6d9ec55e2aab_min.webp
fetch shot-pressed.webp hf_20260907_151650_ab1eaa77-1970-4a07-bc67-dc2faf688dbd_min.webp

echo
echo "The hat — the price-drop reel, so \"Then it moves\" is one product"
fetch hat-price.mp4     hf_20260907_151356_98f2f24a-e878-4b23-8fa9-d157a32a170c.mp4

echo
echo "The bottle — the scroll-scrub sheet, one source and five derived"
fetch oil-source.webp   hf_20260907_152043_e364ce92-08d3-414c-9686-0d07a4495243_min.webp
fetch oil-peach.webp    hf_20260907_152508_7e1680a4-d849-4a22-b273-66a074a477b9_min.webp
fetch oil-teal.webp     hf_20260907_152507_d346b444-d1d2-4877-ab38-46f1bebe3096_min.webp
fetch oil-white.webp    hf_20260907_153004_3ce3665e-448d-42a5-a08f-3eb05ec78357_min.webp
fetch oil-ugc.webp      hf_20260907_152507_f0e3a824-6ba2-4c56-b45d-2786cc344c6a_min.webp
fetch oil-reel.mp4      hf_20260907_152901_05451cef-6604-48b9-8225-e3000446e511.mp4
fetch oil-ugc.mp4       hf_20260907_152901_2f35b3b8-369d-448f-9152-15f3516cd8ad.mp4

echo
echo "The vase — the six-up, four studios, a reel and a UGC ad"
fetch vase-peach.webp   hf_20260907_152257_b3fe9005-6940-4ca2-9280-23454f795333_min.webp
fetch vase-teal.webp    hf_20260907_152257_84148fb7-e31f-4789-a8f4-14388e62a12c_min.webp
fetch vase-white.webp   hf_20260907_152257_6b743205-40ef-4254-a993-9b044d066fcc_min.webp
fetch vase-shelf.webp   hf_20260907_152258_636bfc13-38e9-4695-9a14-f2c4a1aeb501_min.webp
fetch vase-ugc.webp     hf_20260907_152257_e92f66b5-bca8-44a1-826d-a5acda0eb431_min.webp
fetch vase-reel.mp4     hf_20260907_152739_99fb4df3-e96a-4a8f-af2b-31df048a9901.mp4
fetch vase-ugc.mp4      hf_20260907_152739_dfb38b2e-9939-45a9-b7c9-e514d44b55fa.mp4

echo
echo "The baby toy — the sign-in sheet's two clips (its stills are already here)"
fetch toy-reel.mp4      hf_20260907_152404_f408c918-9629-423a-af6f-521749d3f3a0.mp4
fetch toy-ugc.mp4       hf_20260907_152345_462e6e69-56e6-48d3-9d88-35f6f88e0014.mp4

echo
echo "Then, and this part matters — on disk is not what gets deployed:"
echo "  cd \"$REPO\""
echo "  node scripts/sync-prototypes.mjs   # must print no warnings"
echo "  git add apps/web/public/shots"
echo
echo "LOOK AT THEM FIRST — the one check I could not do."
echo "  open \"$DEST\""
echo
echo "Each set must be ONE product throughout, stills and clips alike:"
echo "  shot-*    the same sage-green linen shirt dress — Pressed included"
echo "  oil-*     the same amber bottle with the same printed label"
echo "  vase-*    the same speckled stoneware vase"
echo "  toy-*     the same five rings in the same order"
echo "If any frame redesigned its product, name it and I will regenerate that one."
