# eval — Terminal-Bench 2.0 evaluation rig

Runs the coding agent built from **this** source tree against Terminal-Bench 2.0 through
[Harbor](https://pypi.org/project/harbor/), fully offline against pre-mirrored task images.

Migrated in from a separate `Harness_Engineering` checkout so the edit → build → evaluate → gate loop
lives in one repository. Every payload path is now derived from this directory's location; nothing
outside the pi checkout is read.

## Environment

| Item | Value |
|---|---|
| Python | 3.12.13 (uv-managed, `home` resolves to `~/.local/share/uv/python/...`) |
| harbor | 0.20.0 |
| venv | **recreated**, not copied — see "Recreating the venv" |
| Dependency snapshot | `requirements.lock.txt` (83 packages, frozen from the pre-migration venv) |

## Prerequisites

1. **Docker daemon running.** Both the runtime build and every trial need it.
2. **Task images in the local Docker image store**, tagged `alexgshaw/<task>:20251031`.
   They live in Docker, *not* in this directory — moving or deleting `eval/` does not affect them.
   Re-mirror with `scripts/mirror_tb2_images.py` if `docker system prune` removes them.
3. **`.env`** with the provider credentials:
   ```
   OPENAI_API_KEY=...
   OPENAI_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
   ```
   `run_tb2.sh` exports everything in this file. It is gitignored; see `.env.template`.

## Common commands

Run all of these from this directory.

```bash
# 1. From the parent delivery directory, restore the supplement.
python3 pi-main/eval/scripts/restore_eval_supplement.py \
  --root ./pi-main \
  --snapshot PROJECT_SNAPSHOT.md \
  --archive pi-eval-supplement.tar.gz \
  --manifest pi-eval-supplement.manifest.json

# 2. Rebuild the Python 3.12 venv, patch verifiers, and build/verify the runtime.
cd pi-main/eval
bash scripts/bootstrap_restored_eval.sh

# 3. Configure all three required non-empty values.
cp .env.template .env
# edit OPENAI_API_KEY, OPENAI_BASE_URL, HARNESS_MODEL

# 4. Confirm which tasks are runnable offline right now.
.venv/bin/python scripts/tb2_status.py            # full report
.venv/bin/python scripts/tb2_status.py --ready-list

# 5. Mandatory one-task smoke, then the full ready list.
CONCURRENCY=1 ./run_tb2.sh regex-log
CONCURRENCY=2 MULTIPLIER=2 ./run_tb2.sh

# 6. Report both pass rates and check all gates.
.venv/bin/python analysis/summarize_run.py jobs/<job-id>
cd ..
python3 .gate_check.py eval/jobs/<job-id>
./test.sh
```

Results land in `jobs/<timestamp>/` (Harbor writes to `jobs/` relative to the working directory,
and `run_tb2.sh` cd's here first).

`run_tb2.sh` assigns the Harbor job name before launch and writes matching records under
`run-records/`: `<job-id>-preflight.json` contains source/snapshot/runtime fingerprints, model,
concurrency, host data, and Docker image digests; `<job-id>-health.jsonl` records Docker and free-disk
health throughout the run. Docker failure terminates Harbor and exits 2. Crossing
`EVAL_DISK_FLOOR_GB` (default 6 GB) terminates Harbor and exits 3.

## Runtime resolution order

`benchmarks/pi_agent.py` picks the pi runtime to install, most explicit first:

1. `PI_RUNTIME_TARBALL` environment variable — errors if the path is missing
2. `../.harbor/pi-runtime-linux-x64.tar.gz` — the source build from step 1 above
3. `assets/pi-runtime-linux-x64.tar.gz` — the npm-release fallback

So after building from source you do **not** need to set any environment variable.

## Layout

```
eval/
├── run_tb2.sh                  entry point
├── requirements.lock.txt       dependency snapshot
├── benchmarks/
│   ├── pi_agent.py             the pi adapter (installs runtime, writes models.json, runs `pi -p`)
│   ├── harbor_agent.py         baseline adapter, not runnable from here (see below)
│   └── tb2_tasks.json
├── scripts/                    build / mirror / status / task-patching tooling
├── analysis/                   result comparison and summarisation
├── local_tasks/tb2_all/        89 task definitions, test.sh patched for offline verification
├── assets/                     large binaries (node, pi npm runtime, CPython, pytest wheels)
├── jobs/                       evaluation results, including pre-migration baselines
└── .venv/                      Python 3.12 + harbor 0.20.0
```

## Two things that silently zero a run

Both were paid for in lost benchmark rounds; the guards are in place, keep them.

**Verifier needs a Python interpreter.** `scripts/patch_tb2_tests.py` rewrites each task's `test.sh`
to call pytest via `HARNESS_PY=$(command -v python3 || command -v python)`. Many TB2 images ship no
interpreter, so that resolves to nothing and the script dies on `-m: command not found` before a
single assertion runs — scoring 0 regardless of what the agent did. `pi_agent.py` installs
`assets/cpython-3.12-x86_64.tar.gz` when, and only when, the image has no interpreter of its own.

**Network outages look like agent failures.** A round where containers cannot reach the provider
produces `Connection error` and a meaningless score. Check reachability before a long run:

```bash
curl -s -o /dev/null -w "%{http_code}\n" --max-time 20 \
  https://dashscope.aliyuncs.com/compatible-mode/v1/models     # 401 == reachable
```

## `AGENT=harness` is not available here

`run_tb2.sh` defaults to `AGENT=pi`. The `harness` baseline adapter stages *its own repo root*
(`Path(__file__).parent.parent`) into the container; from this location that is `eval/`, which does
not contain the harness agent implementation. `run_tb2.sh` therefore rejects `AGENT=harness` with an
explanation instead of failing obscurely inside a container.

Historical harness baselines remain usable: their job directories were migrated into `jobs/`, and
`analysis/_compare3.py` reads them directly.

## Recreating the venv

The venv is deliberately rebuilt rather than copied — a virtualenv hardcodes absolute paths in
`pyvenv.cfg` and every `bin/` shebang, so a copied one keeps pointing at the old interpreter and
fails in confusing ways once the original is gone.

```bash
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python -r requirements.lock.txt
```

Verify with:

```bash
.venv/bin/python -V                                  # Python 3.12.13
.venv/bin/python -c "import harbor; print(harbor.__version__)"   # 0.20.0
```
