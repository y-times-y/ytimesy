"""Run-level spend stop for the TB4 sample: spendwatch.py <run-dir> <hard-usd> [--once]

Why: the bridge ledger reserves each trial's whole cap before it starts, so 12 parallel
trials at $8 need a ledger total of $96 just to start. The ledger total is therefore set
to 12 x trial cap, and this watcher enforces the sample's real total ($40 by default):
every 60 s it sums each trial's live spend (the last `usd=` the bridge logged, or its
ledger settlement when larger). At the hard total it writes the ledger stop file, kills
the Harbor jobs and bridges, and writes ABORTED. Overshoot is bounded by what the
in-flight trials spend within one poll. Writes <run-dir>/spend.json; prints no secrets.
"""
import glob
import json
import os
import re
import subprocess
import sys
import time

USD = re.compile(r"usd=([0-9.]+)")


def live_spend(run_dir):
    per_trial = {}
    for log in glob.glob(os.path.join(run_dir, "jobs", "*", "*__*", "agent", "ytimesy-bridge.log")):
        trial = log.split(os.sep)[-3]
        last = 0.0
        try:
            with open(log, errors="replace") as f:
                for line in f:
                    m = USD.search(line)
                    if m:
                        last = float(m.group(1))
        except OSError:
            continue
        per_trial[trial] = last
    settled = {}
    try:
        with open(os.path.join(run_dir, "ledger.jsonl")) as f:
            for line in f:
                if line.strip():
                    entry = json.loads(line)
                    if entry.get("type") == "settle":
                        settled[entry["trial"]] = float(entry["usd"])
    except (OSError, ValueError):
        pass
    for trial, usd in settled.items():
        per_trial[trial] = max(per_trial.get(trial, 0.0), usd)
    return per_trial


def run_processes(run_dir):
    """Pids of this run's Harbor jobs and bridges only: their argv names <run-dir>/jobs
    (Harbor's --jobs-dir, the bridge's logsDir). Linux /proc only; elsewhere none."""
    needle = os.path.join(os.path.abspath(run_dir), "jobs").encode()
    pids = []
    for entry in glob.glob("/proc/[0-9]*/cmdline"):
        pid = int(entry.split("/")[2])
        if pid == os.getpid():
            continue
        try:
            with open(entry, "rb") as f:
                if needle in f.read():
                    pids.append(pid)
        except OSError:
            continue
    return pids


def stop_everything(run_dir, total, hard):
    open(os.path.join(run_dir, "ledger.jsonl.stop"), "w").close()
    with open(os.path.join(run_dir, "ABORTED"), "w") as f:
        f.write(f"spend ${total:.2f} reached the sample's hard total ${hard:.2f} at {time.strftime('%FT%TZ', time.gmtime())}\n")
    pids = run_processes(run_dir)
    for pid in pids:
        subprocess.run(["kill", "-TERM", str(pid)], check=False)
    print(f"sent TERM to {len(pids)} processes of this run", flush=True)


def main():
    run_dir, hard = sys.argv[1], float(sys.argv[2])
    once = "--once" in sys.argv
    warned = set()
    while True:
        per_trial = live_spend(run_dir)
        total = sum(per_trial.values())
        with open(os.path.join(run_dir, "spend.json.tmp"), "w") as f:
            json.dump({"at": time.strftime("%FT%TZ", time.gmtime()), "totalUsd": round(total, 4), "hardUsd": hard, "perTrial": per_trial}, f, indent=1)
        os.replace(os.path.join(run_dir, "spend.json.tmp"), os.path.join(run_dir, "spend.json"))
        for share in (0.5, 0.8):
            if total >= share * hard and share not in warned:
                warned.add(share)
                print(f"{time.strftime('%FT%TZ', time.gmtime())} WARN spend ${total:.2f} >= {int(share * 100)}% of ${hard:.2f}", flush=True)
        if total >= hard and not os.path.exists(os.path.join(run_dir, "ABORTED")):
            print(f"{time.strftime('%FT%TZ', time.gmtime())} STOP spend ${total:.2f} >= ${hard:.2f}", flush=True)
            stop_everything(run_dir, total, hard)
        if once:
            print(f"{time.strftime('%FT%TZ', time.gmtime())} final spend ${total:.2f}", flush=True)
            return
        time.sleep(60)


if __name__ == "__main__":
    main()
