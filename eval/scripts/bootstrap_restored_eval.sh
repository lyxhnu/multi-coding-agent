#!/usr/bin/env bash
set -euo pipefail

EVAL_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PI_ROOT="$(cd "$EVAL_ROOT/.." && pwd)"
DELIVERY_ROOT="$(cd "$PI_ROOT/.." && pwd)"
MANIFEST="$DELIVERY_ROOT/pi-eval-supplement.manifest.json"
BUILD_IMAGE="python:3.13-slim-bookworm"

fail() {
	printf 'bootstrap gate failed: %s\n' "$*" >&2
	exit 1
}

require_command() {
	command -v "$1" >/dev/null 2>&1 || fail "missing command: $1"
}

require_command python3
require_command uv
require_command docker

python3 -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 9) else 1)' || \
	fail "python3 >= 3.9 is required"

docker info >/dev/null 2>&1 || fail "Docker daemon is unavailable"
image_arch="$(docker image inspect --format '{{.Architecture}}' "$BUILD_IMAGE" 2>/dev/null)" || \
	fail "missing $BUILD_IMAGE; pull it explicitly with --platform linux/amd64"
[[ "$image_arch" == "amd64" ]] || fail "$BUILD_IMAGE architecture is $image_arch, expected amd64"

free_gb="$(python3 -c 'import shutil,sys; print(int(shutil.disk_usage(sys.argv[1]).free / 1_000_000_000))' "$PI_ROOT")"
(( free_gb >= 80 )) || fail "free disk is ${free_gb}GB, expected at least 80GB"

[[ -f "$MANIFEST" ]] || fail "missing supplement manifest: $MANIFEST"
python3 "$EVAL_ROOT/scripts/check_eval_assets.py" \
	--root "$PI_ROOT" \
	--snapshot "$PI_ROOT/PROJECT_SNAPSHOT.md" \
	--manifest "$MANIFEST"

printf '%s\n' "Docker Desktop auto-sleep/auto-exit must be disabled before a long run."

cd "$EVAL_ROOT"
printf '%s\n' "=== rebuild Python 3.12 venv ==="
uv venv --clear --python 3.12 .venv
uv pip install --python .venv/bin/python -r requirements.lock.txt

python_version="$(.venv/bin/python -c 'import platform; print(platform.python_version())')"
[[ "$python_version" == 3.12.* ]] || fail "eval/.venv uses Python $python_version, expected 3.12.x"
harbor_version="$(.venv/bin/python -c 'import harbor; print(harbor.__version__)')"
[[ "$harbor_version" == "0.20.0" ]] || fail "expected harbor 0.20.0, found $harbor_version"

printf '%s\n' "=== patch TB2 verifiers for offline pytest ==="
.venv/bin/python scripts/patch_tb2_tests.py

printf '%s\n' "=== build pi runtime from restored source ==="
bash scripts/build_pi_runtime_from_source.sh "$PI_ROOT"

printf '%s\n' "=== verify runtime artifacts ==="
bash "$PI_ROOT/.verify_artifacts.sh"

printf '%s\n' "=== TB2 readiness ==="
status="$(.venv/bin/python scripts/tb2_status.py)"
printf '%s\n' "$status"
if grep -q '^READY (definition + offline verifier + local image): 87$' <<<"$status"; then
	grep -q '^MISSING IMAGE (definition ready, image not mirrored): 2$' <<<"$status" || \
		fail "expected 2 missing images with 87 ready tasks"
	grep -q 'mteb-leaderboard' <<<"$status" || fail "expected mteb-leaderboard to be missing"
	grep -q 'mteb-retrieve' <<<"$status" || fail "expected mteb-retrieve to be missing"
elif ! grep -q '^READY (definition + offline verifier + local image): 89$' <<<"$status"; then
	fail "expected 87 READY / 2 MISSING IMAGE, or 89 READY after both known images are pulled"
fi
grep -q '^total tasks: 89$' <<<"$status" || fail "expected exactly 89 TB2 tasks"
if grep -q '^INCOMPLETE DEFINITION:' <<<"$status"; then
	fail "one or more TB2 definitions are incomplete"
fi

printf '%s\n' "bootstrap complete: Python $python_version, harbor $harbor_version"
