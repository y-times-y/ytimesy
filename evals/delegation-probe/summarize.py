"""Summarize the delegation probe: per arm, YES-hit and NO-false-alarm rates."""
import json, pathlib, sys

here = pathlib.Path(__file__).parent / "results"
rows = []
for arm in ("strict", "current"):
    for line in (here / f"results-{arm}.jsonl").read_text().splitlines():
        rows.append(json.loads(line))
summary = {}
for arm in ("strict", "current"):
    mine = [r for r in rows if r["arm"] == arm and r["outcome"] != "error" and not r.get("error", "").startswith("not started")]
    def rate(label):
        runs = [r for r in mine if r["label"] == label]
        return {"delegated": sum(r["delegated"] for r in runs), "runs": len(runs)}
    summary[arm] = {
        "yesHit": rate("YES"),
        "noFalseAlarm": rate("NO"),
        "either": rate("EITHER"),
        "usd": round(sum(r["usd"] for r in mine), 2),
        "seconds": sum(r["seconds"] for r in mine),
        "runs": [
            {
                "id": r["id"], "round": r["round"], "label": r["label"],
                "outcome": r["outcome"], "requests": r["requests"], "usd": r["usd"],
                "delegations": [(d["role"], d["request"], d["title"]) for d in r["delegations"]],
            }
            for r in sorted(mine, key=lambda r: (r["id"], r["round"]))
        ],
    }
json.dump(summary, sys.stdout, indent=1)
