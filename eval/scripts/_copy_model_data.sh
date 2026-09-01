#!/bin/bash
# Copy the hydrated model-data JSONs from the npm-release runtime tarball into
# the pi-main source tree (src/providers/data), one-off. models.dev is
# unreachable from this network, so upstream's hydrate step cannot run; the
# published package already contains the same files.
set -euo pipefail

EVAL_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PI_ROOT="$(cd "$EVAL_ROOT/.." && pwd)"

EXTRACT=/tmp/pi_npm_extract
DEST="$PI_ROOT/packages/ai/src/providers/data"

rm -rf "$EXTRACT"
mkdir -p "$EXTRACT"
tar -xzf "$EVAL_ROOT/assets/pi-runtime-linux-x64.tar.gz" -C "$EXTRACT"

SRC=$(find "$EXTRACT" -type d -path "*pi-ai/dist/providers/data" | head -1)
[ -n "$SRC" ] || { echo "data dir not found in npm runtime tarball" >&2; exit 1; }
echo "found: $SRC ($(ls "$SRC" | wc -l | tr -d ' ') files)"

mkdir -p "$DEST"
cp "$SRC"/*.json "$DEST"/
# The manifest is dot-prefixed, which the glob above misses — and the
# validator refuses the whole directory without it.
cp "$SRC"/.manifest.json "$DEST"/
echo "copied to $DEST:"
ls "$DEST" | head -5
echo "... total $(ls "$DEST" | wc -l | tr -d ' ') files"
rm -rf "$EXTRACT"
