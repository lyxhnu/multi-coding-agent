#!/bin/bash
# Fetch node linux-x64 as .tar.gz (slim images lack xz) and drop the .xz copy.
# Output lands in the rig's assets/, which is where build_pi_runtime_from_source.sh looks for it.
set -euo pipefail
cd "$(cd "$(dirname "$0")/.." && pwd)"
curl -sL --max-time 400 -o assets/node-v22.23.2-linux-x64.tar.gz \
  "https://registry.npmmirror.com/-/binary/node/v22.23.2/node-v22.23.2-linux-x64.tar.gz"
rm -f assets/node-v22.23.2-linux-x64.tar.xz
ls -lh assets/
