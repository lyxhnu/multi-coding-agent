import os, signal, time
pid = 35713
try:
    os.kill(pid, signal.SIGTERM)
    time.sleep(2)
    try:
        os.kill(pid, 0)
        print("still-running")
    except ProcessLookupError:
        print("stopped")
except ProcessLookupError:
    print("already-stopped")
