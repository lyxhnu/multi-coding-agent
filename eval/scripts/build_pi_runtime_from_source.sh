#!/bin/bash
# Host driver: build the pi runtime tarball FROM LOCAL pi SOURCE.
#
# Wraps pi-main/scripts/build-harbor-runtime.sh with the mounts it expects,
# reusing the python:3.13-slim-bookworm (amd64) image already on this machine —
# node comes from the same v22 tarball the runtime itself ships, so no new
# image pull is needed.
#
# Usage:
#   bash eval/scripts/build_pi_runtime_from_source.sh [/path/to/pi-source]
# Output:
#   <pi-source>/.harbor/pi-runtime-linux-x64.tar.gz   (picked up by pi_agent.py)
set -euo pipefail

EVAL_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# The rig sits at <pi-source>/eval, so the checkout under test is simply its parent.
PI_SRC="${1:-$(cd "$EVAL_ROOT/.." && pwd)}"
NODE_TGZ="$EVAL_ROOT/assets/node-v22.23.2-linux-x64.tar.gz"

[ -d "$PI_SRC/packages/coding-agent" ] || { echo "not a pi source tree: $PI_SRC" >&2; exit 1; }
[ -f "$NODE_TGZ" ] || { echo "missing $NODE_TGZ (see scripts/_fetch_node.sh)" >&2; exit 1; }

mkdir -p "$PI_SRC/.harbor"

docker run --rm --platform linux/amd64 \
  -v "$PI_SRC:/src:ro" \
  -v "$PI_SRC/.harbor:/out" \
  -v "$NODE_TGZ:/node.tar.gz:ro" \
  python:3.13-slim-bookworm \
  bash -c "mkdir -p /usr/local/node && tar -xzf /node.tar.gz -C /usr/local/node --strip-components=1 && export PATH=/usr/local/node/bin:\$PATH && bash /src/scripts/build-harbor-runtime.sh"

echo
echo "done -> $PI_SRC/.harbor/pi-runtime-linux-x64.tar.gz"
echo "run with: cd $EVAL_ROOT && AGENT=pi bash run_tb2.sh <tasks>"
echo "(pi_agent.py already prefers this source build over the npm-release tarball in assets/)"
