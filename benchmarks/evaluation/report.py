"""Paired descriptive evidence, not an automatic Codex-parity declaration."""

import argparse
import hashlib
import json
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
from scipy.stats import bootstrap


def paired_report(protocol: dict, results: list[dict], protocol_hash: str) -> dict:
    expected = {
        (task["id"], repetition, arm)
        for task in protocol["tasks"]
        for repetition in range(protocol["repetitions"])
        for arm in ("ytimesy", "native-codex")
    }
    rows = {}
    for result in results:
        key = (result["taskId"], result["repetition"], result["arm"])
        if key in rows or key not in expected:
            raise ValueError("Duplicate or unexpected evaluation arm")
        if result.get("protocolSha256") != protocol_hash:
            raise ValueError("Evaluation arm does not match the frozen protocol")
        if not isinstance(result["grade"]["passed"], bool):
            raise ValueError("Missing boolean verifier outcome")
        rows[key] = result
    if set(rows) != expected:
        raise ValueError("Missing paired arms; incomplete runs must not be silently excluded")

    benchmarks = defaultdict(list)
    for task in protocol["tasks"]:
        scores = {
            arm: np.mean([
                int(rows[(task["id"], repetition, arm)]["grade"]["passed"])
                for repetition in range(protocol["repetitions"])
            ])
            for arm in ("ytimesy", "native-codex")
        }
        benchmarks[task["benchmark"]].append(scores)

    summaries = {}
    for benchmark, tasks in benchmarks.items():
        differences = np.array([task["ytimesy"] - task["native-codex"] for task in tasks])
        interval = None
        # Repetitions are averaged within tasks: the resampling unit is an independent task.
        if len(tasks) >= 10 and len(set(differences)) > 1:
            estimate = bootstrap(
                (differences,), np.mean, confidence_level=0.95,
                n_resamples=10000, method="percentile", rng=np.random.default_rng(protocol["seed"]),
            )
            interval = [float(estimate.confidence_interval.low), float(estimate.confidence_interval.high)]
        summaries[benchmark] = {
            "independent_tasks": len(tasks),
            "repetitions_per_task": protocol["repetitions"],
            "ytimesy_pass_rate": float(np.mean([task["ytimesy"] for task in tasks])),
            "native_pass_rate": float(np.mean([task["native-codex"] for task in tasks])),
            "paired_difference": float(np.mean(differences)),
            "task_cluster_bootstrap_95_percent_interval": interval,
        }
    failures = Counter(row["grade"].get("failure", "unclassified") for row in results if not row["grade"]["passed"])
    return {
        "status": "descriptive-only-not-parity",
        "protocol_sha256": protocol_hash,
        "benchmarks": summaries,
        "failures_included_in_denominator": dict(failures),
        "acceptance_decision": None,
        "limitations": [
            "No agreed non-inferiority margin or powered final holdout sample.",
            "Resource and network equivalence require independent verification.",
            "Confidence intervals are omitted for tiny or constant task samples.",
            "Provider failures count as failures; diagnose them separately before interpreting harness quality.",
        ],
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("directory", type=Path)
    arguments = parser.parse_args()
    protocol_bytes = (arguments.directory / "protocol.json").read_bytes()
    report = paired_report(
        json.loads(protocol_bytes),
        json.loads((arguments.directory / "results.json").read_text())["results"],
        hashlib.sha256(protocol_bytes).hexdigest(),
    )
    print(json.dumps(report, indent=2))
