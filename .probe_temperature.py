#!/usr/bin/env python3
# Quantify how much of the run-to-run divergence is sampling temperature. pi only forwards temperature
# when a host sets one, and the benchmark harness sets none, so dashscope applies the model default.
# Same prompt, repeated, with and without temperature=0: identical replies mean the default temperature
# is the knob behind the 87% path divergence between runs.
import hashlib
import json
import os
import urllib.error
import urllib.request

BASE = os.environ.get("OPENAI_BASE_URL", "https://dashscope.aliyuncs.com/compatible-mode/v1")
KEY = os.environ.get("OPENAI_API_KEY", "")
MODEL = os.environ.get("HARNESS_MODEL", "qwen3.7-plus")
if not KEY:
    raise SystemExit("OPENAI_API_KEY not set")

# Deliberately a task with several equally reasonable opening moves, like the benchmark tasks.
PROMPT = (
    "You are working in a Linux container at /app. Your task: find out which Python packages are "
    "installed and report the numpy version. Reply with ONLY the single shell command you would run first."
)


def call(extra):
    body = {"model": MODEL, "messages": [{"role": "user", "content": PROMPT}], "max_tokens": 512}
    body.update(extra)
    req = urllib.request.Request(
        BASE + "/chat/completions",
        data=json.dumps(body).encode(),
        headers={"Authorization": "Bearer " + KEY, "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            p = json.loads(resp.read())
            txt = ((p.get("choices") or [{}])[0].get("message") or {}).get("content") or ""
            return txt.strip()
    except urllib.error.HTTPError as e:
        return "REJECTED HTTP %s: %s" % (e.code, e.read().decode(errors="replace")[:120])
    except Exception as e:
        return "ERR %s: %s" % (type(e).__name__, e)


for label, extra in [("default temperature (what the harness uses)", {}), ("temperature=0", {"temperature": 0})]:
    print("=== %s ===" % label)
    outs = []
    for i in range(4):
        t = call(extra)
        outs.append(t)
        h = hashlib.md5(t.encode()).hexdigest()[:8]
        print("  run%d [%s] %s" % (i + 1, h, t.replace("\n", " ")[:88]))
    uniq = len(set(outs))
    print("  -> %d distinct replies out of %d\n" % (uniq, len(outs)))
