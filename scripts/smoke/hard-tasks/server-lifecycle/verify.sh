git diff --quiet HEAD -- server.py API.md || { echo "server.py or API.md was modified"; exit 1; }
test -s token.txt || { echo "token.txt is missing or empty"; exit 1; }
events="$HOME/.licensing-service/events"
test -f "$events" || { echo "the server never started"; exit 1; }
EVENTS="$events" python3 - <<'PY'
import hashlib, os, socket, subprocess, sys
token = open("token.txt").read().strip()
events = [line.split() for line in open(os.environ["EVENTS"]).read().splitlines() if line.strip()]
starts = {e[1]: e[3] for e in events if e[0] == "start"}
stopped = {e[1] for e in events if e[0] == "clean-stop"}
digest = hashlib.sha256(token.encode()).hexdigest()
pids = [pid for pid, sha in starts.items() if sha == digest]
if not pids:
    sys.exit(f"token.txt ({token!r}) is not a token any started server issued")
if not any(pid in stopped for pid in pids):
    sys.exit("the server that issued the token was not stopped gracefully")
probe = socket.socket()
probe.settimeout(1)
if probe.connect_ex(("127.0.0.1", 8790)) == 0:
    sys.exit("something is still listening on 8790")
ps = subprocess.run(["ps", "-eo", "args"], capture_output=True, text=True).stdout
def is_server(line):
    words = line.split()
    return bool(words) and words[0].rsplit("/", 1)[-1].lower().startswith("python") and any(w.endswith("server.py") for w in words[1:3])
if any(is_server(line) for line in ps.splitlines()):
    sys.exit("a server.py process is still running")
print("token matches a gracefully stopped server; port 8790 is free")
PY
