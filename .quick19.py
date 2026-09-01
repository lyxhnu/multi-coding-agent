import json
from pathlib import Path

JOB = Path('/Users/lyx/Downloads/Harness_Engineering-master/jobs/2026-08-18__20-37-34')
paths = sorted(JOB.glob('*__/result.json'))
passed=[]; failed=[]
for p in paths:
    task=p.parent.name.split('__',1)[0]
    r=json.load(open(p))
    reward=((r.get('verifier_result') or {}).get('rewards') or {}).get('reward')
    exc=r.get('exception_info') or {}
    et=exc.get('exception_type') if isinstance(exc,dict) else None
    if reward==1.0:
        passed.append(task)
    else:
        failed.append((task,reward,et))
print(f'completed={len(paths)}/19')
print(f'passed={len(passed)}/{len(paths) if paths else 0}')
print('passed_tasks=' + ','.join(passed))
for t,r,e in failed:
    print(f'failed {t} reward={r} exception={e}')
# quick health signals
bad400=0; length=0; tooluse=0; reductions=0
for trace in JOB.glob('*__/agent/*.jsonl'):
    txt=trace.read_text(errors='replace')
    if 'invalid_parameter_error' in txt or 'max_completion_tokens' in txt:
        bad400 += 1
    reductions += ('"type":"shake"' in txt or '"type": "shake"' in txt or '"type":"compaction"' in txt or '"type": "compaction"' in txt)
    for line in txt.splitlines():
        try: rec=json.loads(line)
        except Exception: continue
        m=rec.get('message') or {}
        if isinstance(m,dict) and m.get('role')=='assistant':
            if m.get('stopReason')=='length': length += 1
            if m.get('stopReason')=='toolUse': tooluse += 1
print(f'bad400_tasks={bad400}')
print(f'reduction_tasks={reductions}')
print(f'assistant_length_turns={length}')
print(f'assistant_tooluse_turns={tooluse}')
