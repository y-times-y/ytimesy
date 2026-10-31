"""Daytona account helper for the TB4 GPU lane, run on the runner host by the controller
(docs/tb4-run-controller.md, "GPU lane on Daytona"). The API key is read from
DAYTONA_KEY_FILE (default /opt/tb4/daytona-key, mode 0600) and never printed.

  python -I daytona-ctl.py list                       JSON list of the account's sandboxes
  python -I daytona-ctl.py delete <id> [<id> ...]     delete, then wait until each is gone
  python -I daytona-ctl.py gpucheck <snapshot> ...    boot each snapshot alone, nvidia-smi, delete;
                                                      exit 1 unless every one reports an H100
  python -I daytona-ctl.py snapshot <name> <image> <cpus> <memory GiB> <disk GiB>
                                                      build a root H100 snapshot FROM <image>
"""
import json
import os
import sys
import time

from daytona import Daytona, DaytonaConfig

GONE = ("destroyed", "archived")


def client():
    with open(os.environ.get("DAYTONA_KEY_FILE", "/opt/tb4/daytona-key")) as f:
        return Daytona(DaytonaConfig(api_key=f.read().strip()))


def state(s):
    st = getattr(s, "state", None)
    return str(getattr(st, "value", st) or "unknown").lower()


def list_all(d):
    res = d.list()
    if hasattr(res, "items"):
        return list(res.items)
    return list(res)


def wait_gone(d, ids, limit=600):
    deadline = time.time() + limit
    left = set(ids)
    while left and time.time() < deadline:
        live = {s.id for s in list_all(d) if state(s) not in GONE}
        left &= live
        if left:
            time.sleep(5)
    return sorted(left)


def cmd_list(d):
    out = []
    for s in list_all(d):
        labels = getattr(s, "labels", None) or {}
        out.append(
            {
                "id": s.id,
                "state": state(s),
                "gpus": getattr(s, "gpu", 0) or 0,
                "cpus": getattr(s, "cpu", 0) or 0,
                "memoryGiB": getattr(s, "memory", 0) or 0,
                "storageGiB": getattr(s, "disk", 0) or 0,
                "createdAt": getattr(s, "created_at", None),
                "lane": labels.get("ytimesy-lane") == "tb4-gpu",
                **({"attemptId": labels["ytimesy-attempt"]} if "ytimesy-attempt" in labels else {}),
            }
        )
    print(json.dumps(out))


def cmd_delete(d, ids):
    by_id = {s.id: s for s in list_all(d)}
    for i in ids:
        s = by_id.get(i)
        if s is None:
            print("absent", i[:12])
            continue
        try:
            d.delete(s)
            print("deleted", i[:12])
        except Exception as e:
            print("delete error", i[:12], type(e).__name__, str(e)[:120])
    left = wait_gone(d, ids)
    print("still listed:", ", ".join(x[:12] for x in left) if left else "none")


def cmd_gpucheck(d, snapshots):
    from daytona import CreateSandboxFromSnapshotParams

    ok = True
    for name in snapshots:
        s = d.create(CreateSandboxFromSnapshotParams(snapshot=name, ephemeral=True, os_user="root"), timeout=900)
        try:
            r = s.process.exec("nvidia-smi --query-gpu=name --format=csv,noheader", timeout=120)
            gpu = (getattr(r, "result", "") or "").strip()
            print(name, "->", gpu, f"(cpu {s.cpu}, memory {s.memory} GiB, disk {s.disk} GiB, gpu {s.gpu})")
            ok &= "H100" in gpu
        finally:
            d.delete(s)
            wait_gone(d, [s.id])
    sys.exit(0 if ok else 1)


def cmd_snapshot(d, name, image, cpus, memory, disk):
    from daytona import CreateSnapshotParams, GpuType, Image, Resources

    img = Image.base(image).dockerfile_commands(["USER root"])
    s = d.snapshot.create(
        CreateSnapshotParams(
            name=name,
            image=img,
            resources=Resources(cpu=int(cpus), memory=int(memory), disk=int(disk), gpu=1, gpu_type=[GpuType("H100")]),
            entrypoint=["sleep", "infinity"],
        ),
        on_logs=lambda _l: None,
        timeout=3600,
    )
    print(name, state(s))


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    d = client()
    cmd, args = sys.argv[1], sys.argv[2:]
    if cmd == "list":
        cmd_list(d)
    elif cmd == "delete" and args:
        cmd_delete(d, args)
    elif cmd == "gpucheck" and args:
        cmd_gpucheck(d, args)
    elif cmd == "snapshot" and len(args) == 5:
        cmd_snapshot(d, *args)
    else:
        print(__doc__)
        sys.exit(2)


if __name__ == "__main__":
    main()
