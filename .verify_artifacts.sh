#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
TARBALL="$ROOT/.harbor/pi-runtime-linux-x64.tar.gz"
SOURCE_PREFIX="pi-runtime/pi-src/packages"

[[ -f "$TARBALL" ]] || {
	echo "missing runtime tarball: $TARBALL" >&2
	exit 1
}

extract() {
	tar -xzOf "$TARBALL" "$1" 2>/dev/null
}

require_present() {
	local label="$1"
	local path="$2"
	local pattern="$3"
	local count
	count="$(extract "$path" | grep -c "$pattern" || true)"
	printf '  %-42s %s\n' "$label" "$count"
	[[ "$count" -gt 0 ]] || {
		echo "artifact gate failed: $label" >&2
		exit 1
	}
}

require_absent() {
	local label="$1"
	local path="$2"
	local pattern="$3"
	local count
	count="$(extract "$path" | grep -c "$pattern" || true)"
	printf '  %-42s %s\n' "$label" "$count"
	[[ "$count" -eq 0 ]] || {
		echo "artifact gate failed: $label" >&2
		exit 1
	}
}

echo "=== tarball ==="
ls -l "$TARBALL"
tar -tzf "$TARBALL" >/dev/null

echo
echo "=== runtime fingerprints ==="
require_present "needsRoomForOutput (agent-session)" \
	"$SOURCE_PREFIX/coding-agent/dist/core/agent-session.js" "needsRoomForOutput"
require_present "needsRoomForOutput (policy)" \
	"$SOURCE_PREFIX/coding-agent/dist/core/compaction/compaction-policy.js" "needsRoomForOutput"
require_present "truncationFloor" \
	"$SOURCE_PREFIX/agent/dist/agent-loop.js" "truncationFloor"
require_present "MAX_CONSECUTIVE...= 2" \
	"$SOURCE_PREFIX/agent/dist/agent-loop.js" "MAX_CONSECUTIVE_TRUNCATION_RECOVERIES = 2"
require_present "shake" \
	"$SOURCE_PREFIX/agent/dist/harness/compaction/shake.js" "collectShakeRegions"
require_present "continueAfterReduction" \
	"$SOURCE_PREFIX/coding-agent/dist/core/agent-session.js" "continueAfterReduction"
require_present "OUTPUT_HEADROOM_MAX_TOKENS" \
	"$SOURCE_PREFIX/coding-agent/dist/core/compaction/compaction-policy.js" "OUTPUT_HEADROOM_MAX_TOKENS"
require_present "task-manager clearTimeout" \
	"$SOURCE_PREFIX/coding-agent/dist/core/tasks/task-manager.js" "clearTimeout"
require_absent "sdk legacy 4-tool list removed" \
	"$SOURCE_PREFIX/coding-agent/dist/core/sdk.js" "defaultActiveToolNames"

echo
echo "=== source freshness ==="
stale_count="$(find "$ROOT/packages" -path '*/src/*.ts' -newer "$TARBALL" -type f | wc -l | tr -d ' ')"
printf '  stale sources: %s\n' "$stale_count"
[[ "$stale_count" -eq 0 ]] || {
	echo "artifact gate failed: source files are newer than the runtime" >&2
	exit 1
}

echo "runtime artifact gate passed"
