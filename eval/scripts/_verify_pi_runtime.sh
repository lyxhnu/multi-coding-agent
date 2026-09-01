#!/bin/bash
# Verify the pi runtime tarball works in a clean container: unpack, configure
# the dashscope provider, and confirm pi resolves it without network access.
set -euo pipefail

tar -xzf /work/.pi_runtime/pi-runtime-linux-x64.tar.gz -C /opt
export PATH=/opt/pi-runtime/bin:$PATH

echo "=== pi version ==="
pi --version

echo "=== configure dashscope provider ==="
mkdir -p ~/.pi/agent
cat > ~/.pi/agent/models.json <<'EOF'
{
  "providers": {
    "dashscope": {
      "name": "DashScope",
      "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
      "api": "openai-completions",
      "apiKey": "placeholder",
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false
      },
      "models": [
        {
          "id": "qwen3.7-plus",
          "name": "Qwen 3.7 Plus",
          "reasoning": true,
          "contextWindow": 131072,
          "maxTokens": 16384
        }
      ]
    }
  }
}
EOF

echo "=== provider visible? ==="
pi --list-models qwen3.7 2>&1 | head -5
