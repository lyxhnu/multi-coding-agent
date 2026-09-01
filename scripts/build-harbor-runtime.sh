#!/bin/bash
# Build a self-contained Harbor/Terminal-Bench runtime from THIS pi source tree.
#
# Output: .harbor/pi-runtime-linux-x64.tar.gz — node22 + the locally built
# coding agent (packages/{tui,ai,agent,coding-agent}) with its node_modules.
# The in-tree evaluation rig (eval/benchmarks/pi_agent.py) picks this tarball up
# automatically, so the loop is: edit pi source → run this script →
# cd eval && AGENT=pi bash run_tb2.sh <tasks>.
#
# Driven from the host by eval/scripts/build_pi_runtime_from_source.sh,
# which supplies the mounts:
#   /src         this repo, read-only
#   /out         .harbor output dir
#   /node.tar.gz node v22 linux-x64 tarball
#
# Design notes:
#   - Only the four packages the CLI needs are installed and built. The root
#     build chain also covers storage/sqlite-node and server; sqlite is a
#     native module and a slim image has no toolchain for it, and the CLI does
#     not import either package.
#   - Source is copied out of the read-only mount because npm writes
#     node_modules into the tree.
#   - Workspace symlinks in node_modules are what let dist/cli.js resolve
#     @earendil-works/* to the LOCAL builds; tar preserves them.
set -euo pipefail

REGISTRY="${NPM_REGISTRY:-https://registry.npmmirror.com}"

echo "=== stage source (read-only mount -> /build) ==="
mkdir -p /build
cp -R /src/. /build/pi-src
cd /build/pi-src
rm -rf .git node_modules packages/*/node_modules .harbor

echo "=== install workspace deps (registry: $REGISTRY) ==="
# Full workspace install: the build toolchain (tsgo, shx) lives in the ROOT
# devDependencies, which --workspace-filtered installs skip. --ignore-scripts
# covers two things at once: the root husky prepare hook (dev-only, absent in
# a slim container) and any native postinstall (sqlite-node's engine is pulled
# in but never built — nothing the CLI runs imports it).
npm install --registry="$REGISTRY" --ignore-scripts --no-audit --no-fund

echo "=== build (tui -> ai -> agent -> coding-agent) ==="
# ai's plain `build` regenerates the model catalog from models.dev, which is
# unreachable here; build:offline is the upstream-sanctioned no-network path
# (the root build:offline chain uses exactly this).
(cd packages/tui && npm run build)
(cd packages/ai && npm run build:offline)
(cd packages/agent && npm run build)
(cd packages/coding-agent && npm run build)

VERSION=$(node -p "require('./packages/coding-agent/package.json').version")
echo "=== built pi-coding-agent $VERSION ==="

echo "=== assemble runtime ==="
mkdir -p /opt/pi-runtime
tar -xzf /node.tar.gz -C /opt/pi-runtime --strip-components=1

# Keep only what the CLI needs at runtime: built packages + node_modules.
mkdir -p /opt/pi-runtime/pi-src/packages
cp -R /build/pi-src/node_modules /opt/pi-runtime/pi-src/node_modules
cp /build/pi-src/package.json /opt/pi-runtime/pi-src/package.json
for p in tui ai agent coding-agent; do
  cp -R "/build/pi-src/packages/$p" "/opt/pi-runtime/pi-src/packages/$p"
done

# Entry point mirroring the npm global install layout used before.
cat > /opt/pi-runtime/bin/pi <<'EOF'
#!/bin/sh
DIR=$(dirname "$(readlink -f "$0")")
exec "$DIR/node" "$DIR/../pi-src/packages/coding-agent/dist/cli.js" "$@"
EOF
chmod +x /opt/pi-runtime/bin/pi

echo "=== smoke: pi --version ==="
/opt/pi-runtime/bin/pi --version

echo "=== pack ==="
mkdir -p /out
tar -czf /out/pi-runtime-linux-x64.tar.gz -C /opt pi-runtime
ls -lh /out/pi-runtime-linux-x64.tar.gz
echo "source version: $VERSION"
