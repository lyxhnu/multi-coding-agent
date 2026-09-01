import glob
import json
import os
import re
from datetime import datetime

JOBS = "/Users/lyx/Downloads/Harness_Engineering-master/"
HEAVY = re.compile(r"pip install|pip3 install|apt-get install|apt install|npm install|cargo build|make -j|conda install|wget |curl -[^ ]*O", re.I)


def load(job):
    rows = []
    for d in sorted(glob.glob(JOBS + job + "/*__*")):
        rp = d + "/result.json"
        if not os.path.exists(rp):
            continue
        r = json.load(open(rp))
        if not (r.get("started_at") and r.get("finished_at")):
            continue
        a = datetime.fromisoformat(r["started_at"].replace("Z", "+00:00"))
        b = datetime.fromisoformat(r["finished_at"].replace("Z", "+00:00"))
        # count heavy download/build commands the agent issued
        heavy = 0
        fs = [p for p in glob.glob(d + "/agent/*.jsonl") if "_trace_builder" not in p]
        for line in (open(fs[0], errors="replace") if fs else []):
            try:
                m = json.loads(line).get("message") or {}
            except Exception:
                continue
            if not isinstance(m, dict) or m.get("role") != "assistant":
                continue
            for c in m.get("content") or []:
                if isinstance(c, dict) and c.get("type") == "toolCall":
                    cmd = str((c.get("arguments") or {}).get("command") or "")
                    if HEAVY.search(cmd):
                        heavy += 1
        rows.append(
            dict(
                task=os.path.basename(d).rsplit("__", 1)[0],
                start=a,
                end=b,
                mins=(b - a).total_seconds() / 60,
                heavy=heavy,
            )
        )
    return rows


for label, job in [("v7", "jobs/2026-08-17__11-55-48"), ("v8", "jobs/2026-08-17__14-13-42")]:
    rows = load(job)
    slow = [r for r in rows if r["mins"] > 20]
    print("=== %s ===" % label)
    print("  超20分任务: %d 个   这些任务里发起重量级下载/编译的命令总数: %d" % (len(slow), sum(r["heavy"] for r in slow)))
    print("  全部任务的重量级命令总数: %d" % sum(r["heavy"] for r in rows))
    # peak concurrency among the slow ones: how many slow tasks were running simultaneously
    peak = 0
    for probe in rows:
        t = probe["start"]
        n = sum(1 for r in slow if r["start"] <= t <= r["end"])
        peak = max(peak, n)
    print("  同时运行的慢任务峰值: %d" % peak)
    for r in sorted(slow, key=lambda x: -x["mins"])[:6]:
        print("    %-30s %5.1f分  重命令=%d  %s~%s" % (r["task"], r["mins"], r["heavy"],
                                                    r["start"].strftime("%H:%M"), r["end"].strftime("%H:%M")))
    print("")
