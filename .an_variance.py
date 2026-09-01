import glob
import json
import os
import statistics as st
from datetime import datetime

JOBS = "/Users/lyx/Downloads/Harness_Engineering-master/"


def stats(job):
    outs, mins, turns_l = [], [], []
    npass = ntask = timeouts = 0
    for d in sorted(glob.glob(JOBS + job + "/*__*")):
        rp = d + "/result.json"
        if not os.path.exists(rp):
            continue
        ntask += 1
        r = json.load(open(rp))
        rw = ((r.get("verifier_result") or {}).get("rewards") or {}).get("reward")
        if rw == 1.0:
            npass += 1
        if "AgentTimeout" in str(r.get("exception_info") or ""):
            timeouts += 1
        if r.get("started_at") and r.get("finished_at"):
            a = datetime.fromisoformat(r["started_at"].replace("Z", "+00:00"))
            b = datetime.fromisoformat(r["finished_at"].replace("Z", "+00:00"))
            mins.append((b - a).total_seconds() / 60)
        fs = [p for p in glob.glob(d + "/agent/*.jsonl") if "_trace_builder" not in p]
        t = 0
        for line in (open(fs[0], errors="replace") if fs else []):
            try:
                m = json.loads(line).get("message") or {}
            except Exception:
                continue
            if not isinstance(m, dict) or m.get("role") != "assistant":
                continue
            t += 1
            o = (m.get("usage") or {}).get("output", 0) or 0
            if o:
                outs.append(o)
        turns_l.append(t)
    return dict(npass=npass, ntask=ntask, timeouts=timeouts, outs=outs, mins=mins, turns=turns_l)


runs = [
    ("v6 maxTokens=16384", "jobs/2026-08-16__23-49-21"),
    ("v7 maxTokens=32768", "jobs/2026-08-17__11-55-48"),
    ("v8 maxTokens=32768", "jobs/2026-08-17__14-13-42"),
]
print("%-22s %8s %6s %9s %10s %10s %11s" % ("", "通过", "超时", "轮数中位", "耗时中位", "耗时最大", "output_p95"))
data = {}
for name, job in runs:
    s = stats(job)
    data[name] = s
    o = sorted(s["outs"])
    print(
        "%-22s %5d/%-2d %6d %9.0f %9.1fm %9.1fm %11.0f"
        % (
            name,
            s["npass"],
            s["ntask"],
            s["timeouts"],
            st.median(s["turns"]),
            st.median(s["mins"]),
            max(s["mins"]),
            o[int(len(o) * 0.95)],
        )
    )

print("\n=== 单轮输出 >16384 的比例（只有提高 maxTokens 后才可能出现）===")
for name in data:
    o = data[name]["outs"]
    big = sum(1 for x in o if x > 16384)
    print("  %-22s %4d/%d 轮 (%.1f%%)" % (name, big, len(o), big / len(o) * 100))

print("\n=== 稳定性：耗时标准差 / 长尾任务数 ===")
for name in data:
    m = data[name]["mins"]
    print("  %-22s 标准差 %5.1f分   超20分的任务 %d 个" % (name, st.stdev(m), sum(1 for x in m if x > 20)))
