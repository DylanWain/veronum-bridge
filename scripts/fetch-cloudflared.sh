#!/usr/bin/env bash
# scripts/fetch-cloudflared.sh
# Downloads the latest cloudflared release for both Mac architectures
# and lipo-combines them into a single universal binary at bin/cloudflared
# so electron-builder can bundle it into Veronum Bridge.app.
#
# Why we don't commit the binary directly:
#   The universal binary is ~76 MB (two ~38 MB per-arch slices fused
#   via lipo). Checking it into git would make every clone 76 MB heavier
#   and we'd have to re-commit on every cloudflared upgrade. This
#   script fetches the latest stable release on demand instead.
#
# Run before:
#   npm run package:mac       # local DMG build
#   npm run publish:mac       # signed + notarized + uploaded to GitHub
#
# Idempotent: if bin/cloudflared already exists with the latest version
# it'll re-download anyway (cheap; ensures freshness). To skip, set
# VERONUM_SKIP_CLOUDFLARED_FETCH=1.

set -euo pipefail

cd "$(dirname "$0")/.."

if [ "${VERONUM_SKIP_CLOUDFLARED_FETCH:-0}" = "1" ] && [ -x bin/cloudflared ]; then
  echo "[fetch-cloudflared] skip (VERONUM_SKIP_CLOUDFLARED_FETCH=1, binary present)"
  exit 0
fi

BASE_URL="https://github.com/cloudflare/cloudflared/releases/latest/download"
TMPDIR="$(mktemp -d -t veronum-cloudflared.XXXXXX)"
trap 'rm -rf "$TMPDIR"' EXIT

echo "[fetch-cloudflared] downloading darwin-arm64 + darwin-amd64..."
curl -sSL -o "$TMPDIR/cf-arm64.tgz" "$BASE_URL/cloudflared-darwin-arm64.tgz"
curl -sSL -o "$TMPDIR/cf-amd64.tgz" "$BASE_URL/cloudflared-darwin-amd64.tgz"

echo "[fetch-cloudflared] extracting..."
mkdir -p "$TMPDIR/arm64" "$TMPDIR/amd64"
tar -xzf "$TMPDIR/cf-arm64.tgz" -C "$TMPDIR/arm64"
tar -xzf "$TMPDIR/cf-amd64.tgz" -C "$TMPDIR/amd64"

echo "[fetch-cloudflared] lipo into universal binary at bin/cloudflared..."
mkdir -p bin
lipo -create \
  "$TMPDIR/arm64/cloudflared" \
  "$TMPDIR/amd64/cloudflared" \
  -output bin/cloudflared
chmod +x bin/cloudflared

echo "[fetch-cloudflared] verify..."
file bin/cloudflared
bin/cloudflared --version | head -1
echo "[fetch-cloudflared] ok ($(du -h bin/cloudflared | cut -f1))"
