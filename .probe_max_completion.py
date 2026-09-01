import json
import os
import urllib.error
import urllib.request

base = os.environ.get("OPENAI_BASE_URL", "https://dashscope.aliyuncs.com/compatible-mode/v1")
key = os.environ["OPENAI_API_KEY"]
model = os.environ.get("HARNESS_MODEL", "qwen3.7-plus")

cases = [
    ("max_completion_tokens=32768 no reasoning", {"max_completion_tokens": 32768}),
    ("max_completion_tokens=65536 no reasoning", {"max_completion_tokens": 65536}),
    ("max_completion_tokens=65536 reasoning_effort=low", {"max_completion_tokens": 65536, "reasoning_effort": "low"}),
    ("max_completion_tokens=65536 reasoning_effort=minimal", {"max_completion_tokens": 65536, "reasoning_effort": "minimal"}),
]
for label, extra in cases:
    body = {"model": model, "messages": [{"role": "user", "content": "hi"}]}
    body.update(extra)
    req = urllib.request.Request(
        base + "/chat/completions",
        data=json.dumps(body).encode(),
        headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            p = json.loads(resp.read())
            u = p.get("usage") or {}
            d = u.get("completion_tokens_details") or {}
            print(label, "ACCEPT", "completion", u.get("completion_tokens"), "reasoning", d.get("reasoning_tokens"))
    except urllib.error.HTTPError as e:
        print(label, "REJECT", e.code, e.read().decode(errors="replace")[:240])
