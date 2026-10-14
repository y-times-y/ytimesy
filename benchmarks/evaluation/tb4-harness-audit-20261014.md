# TB4 harness audit: where the agent loses points (2026-10-14)

Scope: the frozen benchmark harness (`v13-shell-039bee1`: GPT-6.1 Sol, reasoning `max`,
six shell tools) on Terminal-Bench 4.0. Data: the 206 scored trials in the 2026-10-12 backup
(a subset of the 63 original tasks) plus the rerun trials. Sources: our agent's own traces,
bridge logs, final reports and our graders' outputs only. No task test suites or reference
solutions were opened. Findings are about the harness, not about individual tasks; tuning to
a specific task would be overfitting.

## Headline numbers

| | |
|---|---|
| Scored trials (backup) | 206, passed 107 (51.9%) |
| How every trial ended | **206/206: the agent declared itself done.** None reached the 8 h limit. |
| Agent time used | mean 0.6 h of 8 h; median 19 min (passed) and **22 min (failed)**; only 8/206 used more than 2 h |
| Trials under 15 min | 72/206 (pass rate 46/72) |
| Failed trials whose final report admits a gap ("not verified", "could not", "estimate", "assumption") | **41/99**, and they stopped anyway |
| Average model calls / cost per trial | 33 / $1.40 (total $289 for the 206) |

## Root causes of the 99 failed trials

Each failure was classified from the agent's final report against the grader's failed checks.

| Cause | Trials | What it looks like |
|---|---|---|
| **Weak self-verification** | **41** | The agent's own checks pass and the grader's fail: tests that encode the agent's own reading (82-114 passing tests, all 5 trials failing the same check), comparing against its own earlier output instead of a reference, running the code through its own harness rather than the way the grader invokes it (empty output under the grader), normalizing values that the grader compares by type (`bytea` instead of text) |
| **Spec misread / unresolved assumption** | **24** | "I'll treat X as Y" or "documented assumption", then optimizing under that reading; dropping a mandated item; wrong path format (`../output/...` instead of `generated_components/...`) |
| **Premature stop** | **13** | Done in 4-10 minutes with one model form or one repro checked; "hidden-data accuracy remains unverified" at 9 of 480 minutes |
| No grader output in the digest | 10 | Cause not visible (several tasks' graders print nothing on failure) |
| Environment / tooling | 6 | Wrong GPU (see below), missing live-feed token, `pytest` absent |
| **Genuine capability limit** | **5** | Substantive attempt, still wrong |

**Failures are strongly correlated:** the repeats of a task usually make the same choice and fail
the same check. More attempts per task will not fix them; a different default procedure will.

## Engineering work, in priority order

1. **Spend the budget on falsification before stopping.** The harness lets the agent stop at
   minute 5 of 480. Add a completion gate: before a final answer, the agent must list the
   alternative readings, model forms or parameters it did not choose and rule each out with
   evidence, and the loop rejects "done" while time remains and open items exist. Measure:
   share of trials using more than 1 h, pass rate per minute used.
2. **Treat admitted gaps as blockers, not disclosures.** Detect "not verified", "could not run",
   "assumption", "requirement not met", "estimate" in the agent's own report, and send it back
   to resolve each (build and compare both readings, find another way to verify, re-run). 41
   of 99 failures disclosed exactly the gap that failed them.
3. **Independent, spec-derived verification.** A separate fresh-context pass writes checks from
   the task text alone (one per stated requirement and edge case) and tries to break the
   deliverable. The builder's own tests share its assumptions.
4. **Verify the way the grader runs.** Fresh shell, stated working directory and command, a
   different or unprivileged user, a clean checkout, byte and type comparisons, the stated
   time limit. Several "passing" deliverables printed nothing or the wrong type under the grader.
5. **Literal requirement checklist.** Parse paths, formats, separators, file locations and
   mandated items from the prompt into a checklist and check the actual files against it with a
   script before finishing.
6. **Cut polling waste.** 1,962 `continue_command` polls against 3,681 commands (0.53 per
   command). Long-running commands should notify on completion or be awaited with longer
   yields, so model calls go to thinking, not waiting.

## Benchmark-infrastructure findings

- **Wrong GPU, silently.** In job `tb4-gpu-daytona-fp8e` Daytona supplied an **NVIDIA RTX PRO
  6000 Blackwell (sm_120)** for `fp8-rmsnorm-gemm`, which requires an H100. Harbor does not
  enforce `gpu_types` there. The agents said so in their reports; two such trials were graded
  (0.0). The backup cannot show whether they were among the 5 counted in the original fp8 3/5.
  Fix: assert the GPU model inside the trial environment before the agent starts; void
  otherwise. (The rerun's H100 check ran only once per task loop, not per trial.)
- **Trace integrity.** `live-database-cutover` trials in different jobs and time windows
  (`tb4-livedb-attach-*`, `tb4-livedb-ec2`) carry byte-identical agent traces (e.g. three
  trials with trace hash `a639fda4`), so those trials' traces describe another trial's run.
  Fix: write the trace per trial with the trial id and bundle hash inside it, and fail the
  trial if the file already exists.
- **Empty grader output** for several tasks (freight-dispatch, music-harmony, ontology,
  heat-pump): the reason a trial failed is not recorded. Fix: always save the grader's full
  output and exit status.
- **Stream cuts and no transport visibility** (rerun): fixed for runs with the transport guard;
  the frozen bridge itself still does not replay streams.

## What this means for the score

The original run's 55% is mostly limited by **verification and stopping behavior, not model
capability**: 78 of 99 failures were weak verification, a misread spec, or a premature stop,
against 5 genuine capability failures. The largest gains for the next harness version are the
completion gate and independent verification (items 1-3), evaluated as a new harness version
on a held-out split, never by tuning to these tasks.
