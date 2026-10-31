"""Summarize the middle-rule probe: per arm, YES-hit and NO-false-alarm rates.

A run that ended at the 12-step limit (outcome "error" with the tool-step
limit message, or "request-limit") is a valid no-delegation run; only setup
errors and runs the total cap refused are dropped.
Usage: python3 summarize-middle.py <results-<arm>.jsonl>...
"""
import json, sys

rows = [json.loads(l) for p in sys.argv[1:] for l in open(p) if l.strip()]
def valid(r):
    if r.get("error", "").startswith("not started"):
        return False
    if r["outcome"] == "error" and "tool-step limit" not in r.get("error", ""):
        return False
    return True
out = {}
for arm in sorted({r["arm"] for r in rows}):
    mine = [r for r in rows if r["arm"] == arm and valid(r)]
    def rate(label):
        runs = [r for r in mine if r["label"] == label]
        return f'{sum(r["delegated"] for r in runs)}/{len(runs)}'
    out[arm] = {
        "yesHit": rate("YES"),
        "noFalseAlarm": rate("NO"),
        "usd": round(sum(r["usd"] for r in rows if r["arm"] == arm), 2),
        "runs": [
            f'q{r["id"]} r{r["round"]} {r["label"]}: '
            + (", ".join(f'{d["role"]}@{d["request"]} {d["title"]}' for d in r["delegations"]) or f'no ({r["requests"]} req)')
            for r in sorted(mine, key=lambda r: (r["id"], r["round"]))
        ],
    }
json.dump(out, sys.stdout, indent=1)
print()
