#!/bin/bash
# Offline test of sitecustomize section 4 (chunked transfer) against a stub Harbor DaytonaEnvironment.
set -e
T=$(mktemp -d); trap "rm -rf $T" EXIT
mkdir -p $T/stub/harbor/environments/daytona
for d in harbor harbor/environments harbor/environments/daytona; do : > $T/stub/$d/__init__.py; done
cat > $T/stub/harbor/environments/daytona/environment.py <<'PY'
import asyncio, shutil, logging
class R:
    def __init__(s, rc, out, err): s.return_code, s.stdout, s.stderr = rc, out, err
class FS:
    def __init__(s): s.fail_downloads = 1; s.corrupt_uploads = 1; s.calls = []
    async def download_file(s, remote, local, timeout):
        s.calls.append(("down", remote))
        if s.fail_downloads: s.fail_downloads -= 1; raise ConnectionError("injected drop")
        shutil.copyfile(remote, local)
    async def upload_file(s, local, remote, timeout):
        s.calls.append(("up", remote)); shutil.copyfile(local, remote)
        if s.corrupt_uploads and "part." in remote:
            s.corrupt_uploads -= 1
            with open(remote, "ab") as f: f.write(b"x")
class SB:
    def __init__(s): s.fs = FS()
class DaytonaEnvironment:
    def __init__(s): s._is_windows = False; s._sandbox = SB(); s.logger = logging.getLogger("t")
    async def _sandbox_exec(s, command, shell="sh -c", timeout_sec=None, **kw):
        p = await asyncio.create_subprocess_exec("bash", "-c", command, stdout=-1, stderr=-1)
        o, e = await p.communicate(); return R(p.returncode, o.decode(), e.decode())
    async def _sdk_download_dir(s, a, b): raise AssertionError("original download used")
    async def _sdk_upload_dir(s, a, b): raise AssertionError("original upload used")
PY
mkdir -p $T/src/sub/deep $T/src/empty
head -c 300000 /dev/urandom > $T/src/big.bin; head -c 70000 /dev/urandom > $T/src/sub/deep/m.bin
echo hello > $T/src/sub/a.txt; ln -s sub/a.txt $T/src/link; chmod 640 $T/src/sub/a.txt
YTIMESY_DAYTONA_PART_BYTES=65536 YTIMESY_DAYTONA_RELAY_DIR=$T/relay YTIMESY_DAYTONA_RETRY_SEC=0 python3 -I - "$T" "$1" <<'PY'
import sys, asyncio, importlib.util, json, os, subprocess
T, patchdir = sys.argv[1], sys.argv[2]
sys.path.insert(0, T + "/stub")
spec = importlib.util.spec_from_file_location("p", patchdir + "/sitecustomize.py"); spec.loader.exec_module(importlib.util.module_from_spec(spec))
from harbor.environments.daytona import environment as E
async def main():
    env = E.DaytonaEnvironment()
    await env._sdk_download_dir(T + "/src", T + "/artifacts")
    arts = os.listdir(T + "/artifacts"); assert arts == [".ytimesy-relay.json"], arts
    m = json.load(open(T + "/artifacts/.ytimesy-relay.json")); assert len(m["parts"]) >= 6, m["parts"]
    assert not any(n.startswith("ytimesy-xfer") for n in os.listdir("/tmp") if os.path.isdir("/tmp/"+n) and n.endswith(m["relay_dir"][-32:])), "sandbox staging left"
    env2 = E.DaytonaEnvironment()
    await env2._sdk_upload_dir(T + "/artifacts", T + "/dest")
    d = subprocess.run(["diff", "-r", "--no-dereference", T + "/src", T + "/dest"], capture_output=True, text=True)
    assert d.returncode == 0, d.stdout + d.stderr
    assert os.path.islink(T + "/dest/link") and os.path.isdir(T + "/dest/empty")
    assert oct(os.stat(T + "/dest/sub/a.txt").st_mode)[-3:] == "640"
    assert not os.path.exists(m["relay_dir"]), "runner staging not cleaned"
    downs = [c for c in env._sandbox.fs.calls if c[0] == "down"]; assert len(downs) == len(m["parts"]) + 1, len(downs)
    ups = [c for c in env2._sandbox.fs.calls if c[0] == "up"]; assert len(ups) == len(m["parts"]) + 1, len(ups)
    # small path: one tar.gz
    os.environ["YTIMESY_DAYTONA_PART_BYTES"] = str(10**9)
    spec2 = importlib.util.spec_from_file_location("p2", patchdir + "/sitecustomize.py"); spec2.loader.exec_module(importlib.util.module_from_spec(spec2))
    env3 = E.DaytonaEnvironment(); env3._sandbox.fs.fail_downloads = 0
    await env3._sdk_download_dir(T + "/src", T + "/arts2")
    assert not os.path.exists(T + "/arts2/.ytimesy-relay.json")
    await E.DaytonaEnvironment()._sdk_upload_dir(T + "/arts2", T + "/dest2")
    d2 = subprocess.run(["diff", "-r", "--no-dereference", T + "/src", T + "/dest2"], capture_output=True, text=True)
    assert d2.returncode == 0, d2.stdout
    print("TRANSFER-OK parts=%d bytes=%d" % (len(m["parts"]), m["bytes"]))
asyncio.run(main())
PY
