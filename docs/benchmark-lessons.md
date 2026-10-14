# Benchmark run lessons (from the TB4 run and rerun, 2026-10-11 to 2026-10-14)

Read this before starting any benchmark run. Every rule below cost real GPU hours,
model tokens or results when it was missed. The incidents are listed after the checklist.

## Checklist before the first scored trial

1. **Commit the rules first.** Scoring, what counts as infra (rerun, not scored), retry and
   attempt caps, budget stop, and providers go in `benchmarks/evaluation/` before any trial.
   Mid-run changes go in a dated amendment, before the trials they affect.
2. **Freeze and fingerprint the harness.** Build the bridge bundle from a clean commit,
   record its SHA-256 and the commit in the run notes and in every trial's trace. A label
   is not proof.
3. **Secure capacity before starting.** Confirm concurrent GPU quota (AWS `p5.4xlarge`:
   64 vCPU = 4 H100 in us-east-1), provider spend limits and balances (Modal, Daytona,
   OpenAI) cover the whole run with margin. One GPU at a time turns a day into four.
4. **Preflight every task end to end** on the exact environment, outside the scored jobs:
   reference solution scores 1, no-op agent scores 0, and a real agent (time-capped) reaches
   the real grader. Include the largest expected workspace (jax: 150 GB) and the
   "agent hit its time limit" path.
5. **Test infrastructure at production scale with injected failures.** A transfer tested at
   20 GB said nothing about 142 GB; a download that was never interrupted said nothing about
   retries. Inject a dropped connection, a cut model stream and a killed process.
6. **Make every failure observable.** Log the raw provider and transport error (class, HTTP
   status, request id, last stream events) without secrets. Sanitized "unknown" errors cost
   hours of guessing.
7. **Results survive the machine.** No auto-delete on any VM holding results. Copy each
   finished trial off the host (R2) within minutes, and keep a second copy before deleting
   anything.
8. **One owner per run.** Exactly one session may change a running job: launch, stop,
   patch, rule. Others only read and report, and say who owns it.
9. **Monitoring that cannot lapse.** A watcher that re-arms itself (or a cron) and alerts
   on: a trial ending, a log going quiet, spend crossing a threshold. Never depend on
   remembering to re-arm.
10. **Never edit a shared working copy's git index.** Commit from your own worktree
    (`git worktree add`). `git commit` takes everything staged, including another session's
    work.

## Incidents and what they cost

| # | What happened | Cost | Rule |
|---|---|---|---|
| 1 | The original coordinator VM had a 24 h auto-delete; it deleted itself with the run's result files. | 5 fp8 trials (3/5) and 1 ctr pass lost; the whole rerun | 7 |
| 2 | fp8 x5 launched in parallel on Modal without checking the remaining spend limit; the billing-cycle limit killed every agent and grader build at ~45 min. | ~$10 tokens, 5 trials, half a day | 3 |
| 3 | Harbor's Daytona directory transfer packs with gzip under 600 s, stages on the coordinator (Freestyle caps disk at 64 GB), re-packs in Python and unpacks under 600 s. A 63 GB jax `/app` reached the grader empty. | jax never graded in the original run; rerun attempt 1 (6 h H100) | 4, 5 |
| 4 | The first transfer fix was tested at 20 GB with no interrupted connection. A 142 GB single download dropped at 46 GB; curl's retry restarted into the same tar and corrupted the stream. | jax v3-1 (8 h H100) | 5 |
| 5 | OpenAI closed response streams mid-response with no error. The frozen harness does not replay streams (`streamRetries: 0`), so each cut ended the agent. The harness logged `code: unknown, causes: []`, so the cause took hours to find. | jax attempts 1, 3, 4 and two preflights | 5, 6 |
| 6 | No end-to-end preflight before multi-hour GPU trials; each defect surfaced hours into a real trial. | Most of a day | 4 |
| 7 | Several sessions changed the same running job (two fp8 fallbacks, competing transfer fixes, budget offsets). | Duplicate work, a stopped job, confusion over what was running | 8 |
| 8 | An overnight session committed in another session's working copy; the commit swept in that session's 59 staged deletions and two unreviewed commits, and was pushed to `main`. | `main` broken until restored; unreviewed code published | 10 |
| 9 | The monitoring heartbeat was not re-armed for 5 hours. jax v3-1's failure was missed and v3-2 started on the unfixed transfer. | Up to 5 h of H100 on a trial at risk | 9 |
| 10 | The bundle labelled `039bee1` was built from an uncommitted tree; traces record no bundle hash. Whether the original 63 tasks all ran the same bundle cannot be proven. | Weaker "same frozen harness" claim | 2 |
| 11 | The OpenAI spend estimator read only the last usage line (counters reset on compaction) and priced cached input wrongly; the guard was patched with an offset mid-run. | An unreliable budget stop | 6 |
| 12 | Single Daytona H100 (account limit 1, spot needs a higher tier, Tier 3 adds no GPUs); AWS GPU quota was requested only after the run started. | ~3 extra days of projected runtime | 3 |
| 13 | `pkill -f <pattern>` matched the shell running it and killed the operator's own command (twice). | Half-applied cleanups | Kill by PID |
| 15 | Daytona supplied an RTX PRO 6000 Blackwell (sm_120) for an H100-only task (`fp8-rmsnorm-gemm`, job `tb4-gpu-daytona-fp8e`); Harbor does not enforce `gpu_types` there, and nothing checked inside the trial. Two such trials were graded. | Possibly invalid trials in the original fp8 score | Assert the GPU model inside every trial before the agent starts; void otherwise |
| 16 | `live-database-cutover` trials from different jobs and times carry byte-identical agent traces: the trace file was not per trial. | Those trials' evidence describes another run | Per-trial trace with trial id and bundle hash; fail if the file exists |
| 14 | Claims were stated before being checked: a Node fetch timeout as the stream-cut cause, "ctr ran out of time", Daytona cost $290-360 (actual estimate $195-210), "Freestyle has no GPUs" before checking. | Wrong decisions risked; trust | Verify, then state; label guesses as guesses |

Harness behavior findings (why the agent loses points) are in
`benchmarks/evaluation/tb4-harness-audit-20261014.md`.

## Related product engineering lessons from the same days

- Code that passes in Node can fail in Cloudflare Workers: `fetch(..., { redirect: "error" })`
  throws in Workers on every call. Test edge code in `workerd`; a repo test now forbids it.
- A per-minute checkpoint retry woke idle chat VMs forever because the capture always failed
  on the edge; retries need backoff and a recorded failure stage.
