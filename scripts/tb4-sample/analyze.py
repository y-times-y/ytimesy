"""TB4 sample analysis and gate verdict (docs/tb4-sample-gate.md).

  python3 analyze.py <run-dir> [--commit <sha>] [--json out.json]

<run-dir> is a fetched ~/runs/<run-id> (jobs/<task>[-r2]/<trial>/...). Prints per task:
our reward, Codex's rate, cost by role, wall time and errors; then totals, the paired
comparison against Codex's per-task rates and the pre-registered gate verdict.
Standard library only; reads no secrets.
"""
import glob
import json
import os
import re
import sys
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
GO_MIN_PASSES = 7  # pre-registered: Codex expected passes on this sample = 7.0
MAX_MEAN_TRIAL_USD = 3.0
EXPECT = {
    "model": "openai.gpt-6.1-sol",
    "effort": "max",
    "variant_parts": ["lead=fusion", "review=on", "checkerMode=single", "rigor=on", "codeMode=primary"],
    "roles": {"checker": "openai.gpt-6.1-sol", "writer": "openai.gpt-6-luna", "classifier": "openai.gpt-6-luna"},
    "trialUsdCap": 8,
}
# Harbor exceptions that are the environment's fault, not the agent's (one rerun allowed).
INFRA = re.compile(r"EnvironmentStartTimeout|EnvironmentBuild|DockerError|ImagePull|pull access denied|toomanyrequests|"
                   r"AgentSetupTimeout|ConnectionError|No space left|DaemonError|ComposeError", re.I)
LOG_ERRORS = re.compile(r" failed: | stopped: |Invalid command scope|SpendCapReached|request limit reached|Throttling|ECONNRESET")


def load(path):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def ts(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00")) if value else None


def minutes(block):
    if not block or not block.get("started_at") or not block.get("finished_at"):
        return None
    return (ts(block["finished_at"]) - ts(block["started_at"])).total_seconds() / 60


def attempt(job_dir, commit):
    trials = [d for d in glob.glob(os.path.join(job_dir, "*__*")) if os.path.isdir(d)]
    a = {"job": os.path.basename(job_dir), "kind": None, "reward": None, "problems": [], "notes": [],
         "costUsd": None, "byRole": {}, "agentMin": None, "totalMin": None, "requests": None,
         "reviewRounds": None, "logErrors": 0, "incomplete": 0, "webSearch": None}
    if len(trials) != 1:
        a["kind"] = "infra"
        a["problems"].append(f"{len(trials)} trial dirs (killed or never started)")
        return a
    t = trials[0]
    result = load(os.path.join(t, "result.json")) or {}
    trace = load(os.path.join(t, "agent", "ytimesy-trace.json"))
    reward = ((result.get("verifier_result") or {}).get("rewards") or {}).get("reward")
    exc = result.get("exception_info")
    exc_text = f"{exc.get('exception_type', '')}: {(exc.get('exception_message') or '')[:200]}" if exc else None
    a["reward"] = reward
    a["agentMin"] = minutes(result.get("agent_execution"))
    a["totalMin"] = minutes({"started_at": result.get("started_at"), "finished_at": result.get("finished_at")})
    if trace:
        a["costUsd"] = trace.get("costUsd")
        a["requests"] = trace.get("requests")
        a["reviewRounds"] = (trace.get("review") or {}).get("rounds")
        a["webSearch"] = trace.get("webSearch")
        for row in ((trace.get("efficiency") or {}).get("modelRows") or []):
            key = f"{row.get('role')}:{row.get('model')}"
            a["byRole"][key] = a["byRole"].get(key, 0) + (row.get("costUsd") or 0)
        if trace.get("failure"):
            a["problems"].append(f"bridge failure: {str(trace['failure'])[:160]}")
        # Fingerprint: the trial ran what the gate pre-registered.
        if trace.get("model") != EXPECT["model"]:
            a["problems"].append(f"model {trace.get('model')}")
        if trace.get("effort") != EXPECT["effort"]:
            a["problems"].append(f"effort {trace.get('effort')}")
        variant = str(trace.get("variant") or "")
        for part in EXPECT["variant_parts"]:
            if part not in variant:
                a["problems"].append(f"variant lacks {part} ({variant[:120]})")
        roles = trace.get("roleModels") or {}
        for role, model in EXPECT["roles"].items():
            if (roles.get(role) or {}).get("model") != model:
                a["problems"].append(f"role {role} ran {(roles.get(role) or {}).get('model')}")
        if trace.get("trialUsdCap") != EXPECT["trialUsdCap"]:
            a["problems"].append(f"trial cap {trace.get('trialUsdCap')}")
        harness = trace.get("harness") or {}
        if commit and harness.get("commit") != commit:
            a["problems"].append(f"commit {harness.get('commit')}")
    log = os.path.join(t, "agent", "ytimesy-bridge.log")
    if os.path.exists(log):
        with open(log, errors="replace") as f:
            a["logErrors"] = sum(1 for line in f if LOG_ERRORS.search(line))
    tlog = glob.glob(os.path.join(os.path.dirname(os.path.dirname(job_dir)), "logs", f"{a['job']}.transport.log"))
    if tlog:
        with open(tlog[0], errors="replace") as f:
            a["incomplete"] = sum(1 for line in f if "response.incomplete" in line)
    if exc_text and "AgentTimeoutError" in exc_text and reward is not None:
        a["notes"].append("agent used its full timeout (graded)")
        exc_text = None
    if exc_text:
        if INFRA.search(exc_text):
            a["kind"] = "infra"
            a["problems"].append(f"infra: {exc_text}")
        else:
            a["kind"] = "harness"
            a["problems"].append(f"exception: {exc_text}")
    elif reward is None:
        a["kind"] = "infra"
        a["problems"].append("no verifier reward")
    elif trace is None:
        a["kind"] = "harness"
        a["problems"].append("no ytimesy-trace.json")
    elif a["problems"]:
        a["kind"] = "harness"
    else:
        a["kind"] = "valid"
    return a


def pass_tail(rates, observed):
    """P(X >= observed) for X = sum of Bernoulli(rates): how often Codex's own rates reach our count."""
    dist = [1.0]
    for p in rates:
        nxt = [0.0] * (len(dist) + 1)
        for k, x in enumerate(dist):
            nxt[k] += x * (1 - p)
            nxt[k + 1] += x * p
        dist = nxt
    return sum(dist[observed:])


def main():
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    run_dir = sys.argv[1]
    commit = sys.argv[sys.argv.index("--commit") + 1] if "--commit" in sys.argv else None
    sample = load(os.path.join(HERE, "tasks.json"))
    codex = load(os.path.join(HERE, "codex-pertask.json"))["tasks"]
    rows = []
    for entry in sample["tasks"]:
        task = entry["task"]
        jobs = sorted(d for d in glob.glob(os.path.join(run_dir, "jobs", f"{task}*"))
                      if re.fullmatch(re.escape(task) + r"(-r\d)?", os.path.basename(d)))
        attempts = [attempt(j, commit) for j in jobs]
        final = next((a for a in reversed(attempts) if a["kind"] == "valid"), attempts[-1] if attempts else None)
        c = codex[task]
        rows.append({"task": task, "codexRate": c["codexPass"] / c["codexTrials"], "codex": f"{c['codexPass']}/{c['codexTrials']}",
                     "v13Rate": (c["oursV13Pass"] or 0) / (c["oursV13Trials"] or 1), "attempts": attempts, "final": final})

    print(f"{'task':30s} {'ours':>4s} {'codex':>5s} {'v13':>4s} {'usd':>6s} {'agent':>6s} {'total':>6s} {'req':>4s} {'rev':>3s} {'err':>3s} {'inc':>3s}  kind / problems")
    role_totals = {}
    for r in rows:
        a = r["final"]
        if not a:
            print(f"{r['task']:30s} {'-':>4s} {r['codex']:>5s}  not run")
            continue
        ours = "-" if a["reward"] is None else ("1" if a["reward"] >= 1 else "0")
        f = lambda v, fmt: "-" if v is None else format(v, fmt)
        print(f"{r['task']:30s} {ours:>4s} {r['codex']:>5s} {r['v13Rate']:>4.1f} {f(a['costUsd'], '6.2f')} {f(a['agentMin'], '6.1f')} {f(a['totalMin'], '6.1f')} "
              f"{f(a['requests'], '4d')} {f(a['reviewRounds'], '3d')} {a['logErrors']:>3d} {a['incomplete']:>3d}  {a['kind']}"
              + (f" ({len(r['attempts'])} attempts)" if len(r["attempts"]) > 1 else "")
              + ("; " + "; ".join(a["problems"] + a["notes"]) if a["problems"] or a["notes"] else ""))
        if a["byRole"]:
            print(" " * 32 + "cost by role: " + ", ".join(f"{k} ${v:.2f}" for k, v in sorted(a["byRole"].items())))
        for k, v in a["byRole"].items():
            role_totals[k] = role_totals.get(k, 0) + v

    finals = [r["final"] for r in rows if r["final"]]
    valid = [r for r in rows if r["final"] and r["final"]["kind"] == "valid"]
    passes = sum(1 for r in valid if (r["final"]["reward"] or 0) >= 1)
    expected = sum(r["codexRate"] for r in rows)
    expected_v13 = sum(r["v13Rate"] for r in rows)
    sd = sum(r["codexRate"] * (1 - r["codexRate"]) for r in rows) ** 0.5
    cost = sum(a["costUsd"] or 0 for a in finals)
    all_cost = sum(a["costUsd"] or 0 for r in rows for a in r["attempts"])
    infra_reruns = sum(max(0, len(r["attempts"]) - 1) for r in rows)
    harness_bad = [r["task"] for r in rows if r["final"] and r["final"]["kind"] == "harness"]
    infra_bad = [r["task"] for r in rows if not r["final"] or r["final"]["kind"] == "infra"]
    wins = [r["task"] for r in valid if r["final"]["reward"] >= 1 and r["codexRate"] <= 0.4]
    losses = [r["task"] for r in valid if r["final"]["reward"] < 1 and r["codexRate"] >= 0.8]
    lost_sure = [r["task"] for r in valid if r["final"]["reward"] < 1 and r["codexRate"] == 1.0]
    print()
    print(f"valid trials {len(valid)}/{len(rows)}; infra reruns {infra_reruns}; harness-error tasks {harness_bad or 'none'}; infra-unresolved {infra_bad or 'none'}")
    print(f"model cost: final trials ${cost:.2f} (mean ${cost / max(1, len(finals)):.2f}); all attempts ${all_cost:.2f}")
    if role_totals:
        print("cost by role: " + ", ".join(f"{k} ${v:.2f}" for k, v in sorted(role_totals.items())))
    agent_mins = [a["agentMin"] for a in finals if a["agentMin"] is not None]
    if agent_mins:
        print(f"agent wall minutes: median {sorted(agent_mins)[len(agent_mins) // 2]:.1f}, max {max(agent_mins):.1f}")
    print()
    print(f"paired vs Codex: ours {passes}/{len(rows)} vs Codex expected {expected:.1f} (sd {sd:.2f} under Codex's rates); "
          f"difference {passes - expected:+.1f} trials = {100 * (passes - expected) / len(rows):+.1f} pts on this sample")
    print(f"  P(Codex's own rates reach >= {passes}) = {pass_tail([r['codexRate'] for r in rows], passes):.2f}; v13 expected {expected_v13:.1f}")
    print(f"  wins (we pass, Codex <= 2/5): {wins or 'none'}")
    print(f"  losses (we fail, Codex >= 4/5): {losses or 'none'}")

    clean = len(valid) == len(rows) and not harness_bad and infra_reruns <= 2
    score_ok = passes >= GO_MIN_PASSES
    cost_ok = cost / max(1, len(finals)) <= MAX_MEAN_TRIAL_USD
    aborted = os.path.exists(os.path.join(run_dir, "ABORTED"))
    print()
    print(f"G1 clean (12 valid, no harness error, <= 2 infra reruns, not aborted): {'PASS' if clean and not aborted else 'FAIL'}")
    print(f"G2 passes >= {GO_MIN_PASSES}: {'PASS' if score_ok else 'FAIL'} ({passes})")
    print(f"G3 failed Codex-5/5 tasks needing a cause label from the trajectory: {lost_sure or 'none'}")
    print(f"G4 mean model cost per trial <= ${MAX_MEAN_TRIAL_USD:.0f}: {'PASS' if cost_ok else 'FAIL'}")
    if not (clean and not aborted):
        verdict = "NO-GO: not clean (fix the harness or infra, then rerun the sample)"
    elif not score_ok:
        verdict = "NO-GO: below Codex's expected passes on the sample"
    elif not cost_ok:
        verdict = "HOLD: score passes but cost per trial is above plan; re-plan caps before the full run"
    elif lost_sure:
        verdict = "GO only if every G3 failure is labeled not harness-caused (else NO-GO)"
    else:
        verdict = "GO"
    print(f"VERDICT: {verdict}")
    if "--json" in sys.argv:
        with open(sys.argv[sys.argv.index("--json") + 1], "w") as f:
            json.dump({"rows": rows, "passes": passes, "expectedCodex": expected, "costUsd": cost, "verdict": verdict}, f, indent=1, default=str)


if __name__ == "__main__":
    main()
