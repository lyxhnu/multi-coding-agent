import socket
import urllib.request

socket.setdefaulttimeout(8)

TARGETS = [
    ("pypi.org", "https://pypi.org/simple/"),
    ("files.pythonhosted.org", "https://files.pythonhosted.org/"),
    ("mirrors.aliyun.com/pypi", "https://mirrors.aliyun.com/pypi/simple/"),
    ("mirrors.aliyun.com/debian", "https://mirrors.aliyun.com/debian/"),
    ("deb.debian.org", "http://deb.debian.org/debian/"),
    ("github.com", "https://github.com/"),
    ("raw.githubusercontent.com", "https://raw.githubusercontent.com/"),
    ("cdn.jsdelivr.net", "https://cdn.jsdelivr.net/"),
    ("registry.npmmirror.com", "https://registry.npmmirror.com/"),
    ("registry-1.docker.io", "https://registry-1.docker.io/v2/"),
    ("dashscope.aliyuncs.com", "https://dashscope.aliyuncs.com/"),
    ("mirrors.cloud.tencent.com", "https://mirrors.cloud.tencent.com/pypi/simple/"),
]

for name, url in TARGETS:
    try:
        resp = urllib.request.urlopen(url)
        print(f"  {name:26} OK    {resp.status}")
    except urllib.error.HTTPError as e:
        print(f"  {name:26} HTTP  {e.code}   (host reachable)")
    except Exception as e:
        print(f"  {name:26} FAIL  {str(e)[:52]}")

# DNS works at all?
for host in ("pypi.org", "github.com", "mirrors.aliyun.com"):
    try:
        print(f"  dns {host:22} -> {socket.gethostbyname(host)}")
    except Exception as e:
        print(f"  dns {host:22} FAIL {e}")
