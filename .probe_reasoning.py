#!/usr/bin/env python3
# Does dashscope actually honour reasoning_effort? The truncation fix steps this parameter down, so if
# the provider ignores it the step-down is a no-op and a different lever is needed. Compares
# reasoning_tokens for the same prompt across settings; a prompt that invites long deliberation is used
# so differences show up.
import json
import os
import urllib.error
import urllib.request

BASE = os.environ.get("OPENAI_BASE_URL", "https://dashscope.aliyuncs.com/compatible-mode/v1")
KEY = os.environ.get("OPENAI_API_KEY", "")
MODEL = os.environ.get("HARNESS_MODEL", "qwen3.7-plus")

if not KEY:
    raise SystemExit("OPENAI_API_KEY not set")

PROMPT = (
    "Think through this carefully step by step: what is the optimal strategy for the 21-stone "
    "Nim game where each player may take 1 to 4 stones and the player taking the last stone wins? "
    "Consider all cases."
)


def call(extra):
    body = {"model": MODEL, "messages": [{"role": "user", "content": PROMPT}], "max_tokens": 2048}
    body.update(extra)
    req = urllib.request.Request(
        BASE + "/chat/completions",
        data=json.dumps(body).encode(),
        headers={"Authorization": "Bearer " + KEY, "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            p = json.loads(resp.read())
            u = p.get("usage") or {}
            d = u.get("completion_tokens_details") or {}
            return {
                "ok": True,
                "reasoning": d.get("reasoning_tokens"),
                "completion": u.get("completion_tokens"),
                "finish": (p.get("choices") or [{}])[0].get("finish_reason"),
            }
    except urllib.error.HTTPError as e:
        return {"ok": False, "err": "HTTP %s: %s" % (e.code, e.read().decode(errors="replace")[:200])}
    except Exception as e:
        return {"ok": False, "err": "%s: %s" % (type(e).__name__, e)}


cases = [
    ("no parameter (what pi sends today)", {}),
    ("reasoning_effort=low", {"reasoning_effort": "low"}),
    ("reasoning_effort=minimal", {"reasoning_effort": "minimal"}),
    ("enable_thinking=False", {"enable_thinking": False}),
]

print("model=%s\n" % MODEL)
for label, extra in cases:
    r = call(extra)
    if r["ok"]:
        print("  %-36s reasoning_tokens=%-6s completion=%-6s finish=%s"
              % (label, r["reasoning"], r["completion"], r["finish"]))
    else:
        print("  %-36s REJECTED %s" % (label, r["err"]))
