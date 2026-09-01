#!/usr/bin/env python3
"""Patch TB2 verifier test.sh scripts so verification works offline locally.

Network reality on this machine (verified): containers cannot reliably reach
deb.debian.org / pypi.org / astral.sh / github.com; mirrors.aliyun.com works
but is flaky under emulation + concurrency. A verifier that cannot install
pytest reports reward=0 even when the agent solved the task, which destroys
the signal we actually want to measure.

Transformations (source of truth is always tests/test.sh.stock):
  1. Prelude: remap apt sources to Aliyun, point pip at the Aliyun index,
     detect the interpreter, and put the vendored pytest wheels on PYTHONPATH.
  2. pytest comes from tests/_wheels/*.whl via zipimport — pure-Python wheels
     import straight out of the zip, so neither pip nor network is required.
  3. uv bootstrap (`curl astral.sh | sh`) and `uvx ... pytest` blocks are
     replaced with a plain interpreter call. Extra `-w PKG` wheels carried by
     the uvx line (gitpython, numpy, torch, ...) are real test dependencies and
     are reinstalled via pip first — dropping them makes collection fail with
     ModuleNotFoundError and silently zeroes the task.
  4. `pip install` lines lose their pytest tokens; if nothing else remains the
     line is dropped, otherwise it is kept as best-effort (`|| true`).
  5. `apt-get install -y curl` (only ever needed to bootstrap uv) is dropped;
     other apt installs are kept as best-effort.

Usage: python3 scripts/patch_tb2_tests.py [task ...]
"""
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TASKS = ROOT / "local_tasks" / "tb2_all"
WHEELS_SRC = ROOT / "assets" / "pytest_wheels"
MARKER = "# [harness-local-patch]"

PRELUDE = f"""{MARKER} offline verifier setup (auto-generated; edit the patcher, not this)
for f in /etc/apt/sources.list /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources; do
  [ -f "$f" ] || continue
  sed -i -E 's|https?://deb\\.debian\\.org|https://mirrors.aliyun.com|g;
             s|https?://security\\.debian\\.org|https://mirrors.aliyun.com|g;
             s|https?://archive\\.ubuntu\\.com|https://mirrors.aliyun.com|g;
             s|https?://security\\.ubuntu\\.com|https://mirrors.aliyun.com|g;
             s|https?://ports\\.ubuntu\\.com|https://mirrors.aliyun.com|g' "$f" 2>/dev/null || true
done
export PIP_INDEX_URL=https://mirrors.aliyun.com/pypi/simple
export PIP_TRUSTED_HOST=mirrors.aliyun.com
export PIP_BREAK_SYSTEM_PACKAGES=1
export PIP_DISABLE_PIP_VERSION_CHECK=1
HARNESS_PY=$(command -v python3 || command -v python)
# pytest + plugins ride along as pure-Python wheels; zipimport needs no pip.
for w in /tests/_wheels/*.whl; do
  [ -f "$w" ] && PYTHONPATH="$w:$PYTHONPATH"
done
export PYTHONPATH
# end offline verifier setup
"""

PYTEST_CALL = "$HARNESS_PY -m pytest"
PYTEST_TOKEN = re.compile(r"^pytest(==[\d.]+)?$|^pytest-json-ctrf(==[\d.]+)?$")

# `uvx \ <opts> \ pytest ARGS` (line continuations) -> single interpreter call
UVX_BLOCK = re.compile(r"uvx\s*\\\n((?:[^\n]*\\\n)*?)\s*pytest\s+([^\n]+)")
UVX_WHEEL = re.compile(r"-w\s+(\S+)")
UV_BOOTSTRAP = re.compile(r"^.*curl\s+-LsSf\s+https://astral\.sh/uv[^\n]*$", re.M)
UV_ENV = re.compile(r"^\s*source\s+\$HOME/\.local/bin/env\s*$", re.M)
PIP_INSTALL = re.compile(r"^(\s*)((?:\S*python\S*\s+-m\s+)?pip3?)\s+install\s+([^\n|&;]+)$", re.M)
APT_INSTALL = re.compile(r"^(\s*)(.*apt-get\s+install\s+-y\s+)([^\n|&;]+)$", re.M)
# A failing `apt-get update` must not abort a `set -e` verifier script.
APT_UPDATE = re.compile(r"^(\s*)(.*apt-get\s+update)\s*$", re.M)
BARE_PYTEST = re.compile(r"^(\s*)(?:(?:\S*python\S*)\s+-m\s+)?pytest\s+(?!--version)([^\n]+)$", re.M)


def strip_pytest_pkgs(pkg_str: str) -> tuple[list[str], list[str]]:
    """Split a pip package list into (pytest-ish, everything else)."""
    flags = [t for t in pkg_str.split() if t.startswith("-")]
    pkgs = [t for t in pkg_str.split() if not t.startswith("-")]
    ours = [p for p in pkgs if PYTEST_TOKEN.match(p)]
    rest = [p for p in pkgs if not PYTEST_TOKEN.match(p)]
    return ours, (flags + rest if rest else [])


def uvx_repl(m: re.Match) -> str:
    """Rewrite a `uvx ... pytest ARGS` block, preserving its extra wheels."""
    opts, pytest_args = m.group(1), m.group(2).strip()
    extra = [w for w in UVX_WHEEL.findall(opts) if not PYTEST_TOKEN.match(w)]
    lines = []
    if extra:
        lines.append(f"$HARNESS_PY -m pip install {' '.join(extra)} || true"
                     "  # test deps from the original uvx line")
    lines.append(f"{PYTEST_CALL} {pytest_args}")
    return "\n".join(lines)


def patch_text(text: str) -> str:
    text = UV_BOOTSTRAP.sub("true  # uv bootstrap dropped (upstream unreachable)", text)
    text = UV_ENV.sub("true", text)
    text = UVX_BLOCK.sub(uvx_repl, text)

    def pip_repl(m: re.Match) -> str:
        indent, _, pkgs = m.groups()
        ours, rest = strip_pytest_pkgs(pkgs)
        if not rest:
            return f"{indent}true  # pytest provided offline via /tests/_wheels"
        line = f"{indent}$HARNESS_PY -m pip install {' '.join(rest)} || true"
        if ours:
            line += "  # pytest itself comes from /tests/_wheels"
        return line

    text = PIP_INSTALL.sub(pip_repl, text)

    def apt_repl(m: re.Match) -> str:
        indent, prefix, pkgs = m.groups()
        keep = [p for p in pkgs.split() if p != "curl"]
        if not keep:
            return f"{indent}true  # apt curl dropped (was only for uv bootstrap)"
        return f"{indent}{prefix}{' '.join(keep)} || true"

    text = APT_INSTALL.sub(apt_repl, text)
    text = APT_UPDATE.sub(lambda m: f"{m.group(1)}{m.group(2)} || true", text)
    text = BARE_PYTEST.sub(lambda m: f"{m.group(1)}{PYTEST_CALL} {m.group(2)}", text)

    lines = text.split("\n")
    at = 1 if lines and lines[0].startswith("#!") else 0
    lines.insert(at, "\n" + PRELUDE)
    return "\n".join(lines)


def main():
    wheels = sorted(WHEELS_SRC.glob("*.whl"))
    if not wheels:
        raise SystemExit(f"no wheels in {WHEELS_SRC} — run the pip download step first")

    names = sys.argv[1:]
    dirs = ([TASKS / n for n in names] if names
            else sorted(d for d in TASKS.iterdir() if d.is_dir()))

    patched = 0
    for d in dirs:
        ts = d / "tests" / "test.sh"
        stock = d / "tests" / "test.sh.stock"
        if not ts.exists() and not stock.exists():
            print(f"-- {d.name}: no tests/test.sh")
            continue
        if not stock.exists():
            shutil.copy2(ts, stock)
        ts.write_text(patch_text(stock.read_text()))

        wdir = d / "tests" / "_wheels"
        wdir.mkdir(exist_ok=True)
        for w in wheels:
            dst = wdir / w.name
            if not dst.exists() or dst.stat().st_size != w.stat().st_size:
                shutil.copy2(w, dst)
        patched += 1

        body = ts.read_text()
        bad = [t for t in ("curl -LsSf", "\nuvx", "uvx \\") if t in body]
        if bad:
            print(f"!! {d.name}: unconverted {bad}")
        if "-m pytest" not in body:
            print(f"!! {d.name}: no pytest invocation found — check manually")

    print(f"patched {patched} tasks with {len(wheels)} offline wheels each")


if __name__ == "__main__":
    main()
