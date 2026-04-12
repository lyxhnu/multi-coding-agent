# Benchmarks

Adapters for running the harness agent on standard evaluation benchmarks.

## Terminal-Bench 2.0 (via Harbor)

### Prerequisites

```bash
# Install harbor framework
pip install harbor

# Docker must be running (or use --env daytona for cloud)
docker info

# Export your API credentials
export $(grep -v '^#' .env | xargs)
```

### Run

```bash
# Prepare a local Terminal-Bench 2.0 checkout, rewrite task docker_image
# entries to GHCR, then run a single task
python benchmarks/run_terminal_bench.py --task fix-git

# Run multiple tasks from the local rewritten dataset
python benchmarks/run_terminal_bench.py --task fix-git --task query-optimize

# Run the full local 2.0 dataset
python benchmarks/run_terminal_bench.py --full

# Use Daytona instead of local Docker
python benchmarks/run_terminal_bench.py --task fix-git --env daytona

# Force Harbor to build environments instead of using task docker_image
python benchmarks/run_terminal_bench.py --task fix-git --force-build
```

### How it works

1. The launcher downloads a repo-local `terminal-bench-2` dataset archive when needed
2. It rewrites each task's `docker_image` to `ghcr.io/laude-institute/terminal-bench/<task>:2.0`
3. Harbor runs against the local dataset via `--path`, avoiding registry task metadata drift
4. `HarnessAgent.install()` clones our repo inside the task container
5. Harbor runs `python3 harness.py --profile terminal "<task>"` in the container
6. Harbor evaluates the result using the task's `tests/test.sh`
