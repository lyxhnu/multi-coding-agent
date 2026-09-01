#!/usr/bin/env bash
set -euo pipefail

EVAL_ROOT="$(cd "$(dirname "$0")" && pwd)"
PI_ROOT="$(cd "$EVAL_ROOT/.." && pwd)"
cd "$EVAL_ROOT"

fail() {
	printf 'run_tb2: %s\n' "$*" >&2
	exit 1
}

[[ -f .env ]] || fail "missing eval/.env; copy .env.template and fill all required values"
set -a
# shellcheck disable=SC1091
source .env
set +a
for required in OPENAI_API_KEY OPENAI_BASE_URL HARNESS_MODEL; do
	value="${!required-}"
	[[ -n "$value" ]] || fail "$required must be non-empty in eval/.env"
done

[[ -x .venv/bin/python && -x .venv/bin/harbor ]] || \
	fail "eval/.venv is missing; run scripts/bootstrap_restored_eval.sh"

MULTIPLIER="${MULTIPLIER:-2}"
CONCURRENCY="${CONCURRENCY:-2}"
EVAL_DISK_FLOOR_GB="${EVAL_DISK_FLOOR_GB:-6}"
EVAL_HEALTH_INTERVAL_SECONDS="${EVAL_HEALTH_INTERVAL_SECONDS:-60}"
[[ "$CONCURRENCY" =~ ^[1-9][0-9]*$ ]] || fail "CONCURRENCY must be a positive integer"
[[ "$MULTIPLIER" =~ ^[1-9][0-9]*([.][0-9]+)?$ ]] || fail "MULTIPLIER must be positive"
[[ "$EVAL_DISK_FLOOR_GB" =~ ^[0-9]+([.][0-9]+)?$ ]] || fail "EVAL_DISK_FLOOR_GB must be numeric"

export PYTHONPATH="$EVAL_ROOT"
export HARNESS_TIMEOUT_MULTIPLIER="$MULTIPLIER"

case "${AGENT:-pi}" in
	pi) IMPORT_PATH="benchmarks.pi_agent:PiAgent" ;;
	harness)
	fail "AGENT=harness is unavailable here; use the original Harness_Engineering checkout"
	;;
	*) fail "unknown AGENT '$AGENT' (expected: pi)" ;;
esac

ready_line="$(.venv/bin/python scripts/tb2_status.py --ready-list)"
read -r -a ready_tasks <<<"$ready_line"
(( ${#ready_tasks[@]} > 0 )) || fail "no READY TB2 tasks"

is_ready() {
	local requested="$1"
	local ready
	for ready in "${ready_tasks[@]}"; do
		[[ "$ready" == "$requested" ]] && return 0
	done
	return 1
}

if (( $# > 0 )); then
	TASKS=("$@")
	for task in "${TASKS[@]}"; do
		is_ready "$task" || fail "task is not READY: $task"
	done
else
	TASKS=("${ready_tasks[@]}")
fi

if [[ -n "${PI_RUNTIME_TARBALL:-}" ]]; then
	RUNTIME_TARBALL="$PI_RUNTIME_TARBALL"
elif [[ -f "$PI_ROOT/.harbor/pi-runtime-linux-x64.tar.gz" ]]; then
	RUNTIME_TARBALL="$PI_ROOT/.harbor/pi-runtime-linux-x64.tar.gz"
else
	RUNTIME_TARBALL="$EVAL_ROOT/assets/pi-runtime-linux-x64.tar.gz"
fi
[[ -f "$RUNTIME_TARBALL" ]] || fail "missing pi runtime tarball: $RUNTIME_TARBALL"
SNAPSHOT="$PI_ROOT/PROJECT_SNAPSHOT.md"
[[ -f "$SNAPSHOT" ]] || fail "missing source snapshot: $SNAPSHOT"

JOB_ID="${JOB_ID:-$(date -u +%Y-%m-%d__%H-%M-%S)}"
[[ "$JOB_ID" =~ ^[A-Za-z0-9._-]+$ ]] || fail "JOB_ID contains unsafe characters: $JOB_ID"
PREFLIGHT="$EVAL_ROOT/run-records/$JOB_ID-preflight.json"
HEALTH="$EVAL_ROOT/run-records/$JOB_ID-health.jsonl"
[[ ! -e "$EVAL_ROOT/jobs/$JOB_ID" ]] || fail "job already exists: jobs/$JOB_ID"
[[ ! -e "$PREFLIGHT" && ! -e "$HEALTH" ]] || fail "run record already exists for $JOB_ID"
mkdir -p run-records

.venv/bin/python scripts/write_run_preflight.py \
	--output "$PREFLIGHT" \
	--root "$PI_ROOT" \
	--snapshot "$SNAPSHOT" \
	--runtime "$RUNTIME_TARBALL" \
	--task-root "$EVAL_ROOT/local_tasks/tb2_all" \
	--job-id "$JOB_ID" \
	--model "$HARNESS_MODEL" \
	--base-url "$OPENAI_BASE_URL" \
	--concurrency "$CONCURRENCY" \
	--multiplier "$MULTIPLIER" \
	-- "${TASKS[@]}"

printf 'Running %d task(s), job %s, concurrency %s, timeout x%s, agent %s:\n' \
	"${#TASKS[@]}" "$JOB_ID" "$CONCURRENCY" "$MULTIPLIER" "${AGENT:-pi}"
printf '  %s\n' "${TASKS[@]}"

include_args=()
for task in "${TASKS[@]}"; do
	include_args+=(-i "$task")
done

harbor_command=(
	.venv/bin/harbor run
	-p local_tasks/tb2_all
	"${include_args[@]}"
	--agent-import-path "$IMPORT_PATH"
	--agent-timeout-multiplier "$MULTIPLIER"
	--agent-setup-timeout-multiplier "$MULTIPLIER"
	--environment-build-timeout-multiplier "$MULTIPLIER"
	--job-name "$JOB_ID"
	--jobs-dir jobs
	-n "$CONCURRENCY"
)

exec .venv/bin/python scripts/run_health_monitor.py \
	--health-file "$HEALTH" \
	--disk-path "$EVAL_ROOT" \
	--disk-floor-gb "$EVAL_DISK_FLOOR_GB" \
	--interval "$EVAL_HEALTH_INTERVAL_SECONDS" \
	-- "${harbor_command[@]}"
