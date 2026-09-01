#!/bin/bash
# Build the self-contained pi runtime tarball for TB2 containers (linux/amd64).
#
# Runs inside python:3.13-slim-bookworm (amd64) — the same base family as the
# TB2 task images — so every native artifact npm lays down is the right
# platform. Output: .pi_runtime/pi-runtime-linux-x64.tar.gz containing node 22
# plus a global install of @earendil-works/pi-coding-agent.
set -euo pipefail

cd /work
mkdir -p /opt/pi-runtime
tar -xzf .pi_runtime/node-v22.23.2-linux-x64.tar.gz -C /opt/pi-runtime --strip-components=1
export PATH=/opt/pi-runtime/bin:$PATH

node --version
npm --version

# npmmirror keeps the container path network-independent of npmjs.org flakiness.
npm install -g --registry=https://registry.npmmirror.com @earendil-works/pi-coding-agent

pi --version

tar -czf .pi_runtime/pi-runtime-linux-x64.tar.gz -C /opt pi-runtime
ls -lh .pi_runtime/pi-runtime-linux-x64.tar.gz
