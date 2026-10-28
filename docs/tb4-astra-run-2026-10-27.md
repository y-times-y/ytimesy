# TB4 run: GPT-6 Astra xhigh, 66 tasks x 5 (rules, fixed before the first trial)

Prepared 2026-10-27. Rules here are fixed before the first scored trial. A change after
that is a dated amendment at the end, committed before the trials it affects. The
controller is `scripts/tb4-run/` (docs/tb4-run-controller.md); this run differs from the
Sol plan in `docs/tb4-scoring-rule.md` only where stated here.

## 1. What runs

- Terminal-Bench 4.0 (`terminal-bench/terminal-bench@4.0.0`), all 66 tasks, 5 trials each
  (330 scored trials), Harbor 0.24.0, Harbor's local `docker` environment on EC2 hosts.
- Model: GPT-6 Astra, effort xhigh, Bedrock route (`openai.gpt-6-astra`, mantle endpoint,
  us-east-1). Effort matches both baselines (their public jobs ran xhigh).
- Harness: bridge v2, `YTIMESY_HARBOR_VARIANT=codeMode=on,plan=on,helpers=write,fetch=on,search=function,checks=<proportion|full>`
  (the `checks` value is set from the 2026-10-27 A/B before freezing and recorded here as an
  amendment). Web search on (function tool), web fetch on, subagents on (read-only helpers and
  writers in the builder's workspace).
- All 5 trials per task start together: `controller.ts init --open-all` opens batches b1
  (1 trial) and b2 (4 trials) at init. There is no batch-2 gate in this run (section 5 has
  the pre-committed early-stop gates).

## 2. Freeze

1. Merge the final harness into the run branch; `pnpm -s vitest run` on the touched areas
   and the full suite once; commit; no uncommitted files (`git status --porcelain` empty).
2. `git tag tb4-astra-2026-10-27 <sha>`; build the bridge bundle from that clean tree and
   record its SHA-256.
3. `controller.ts init --run-id tb4-astra-2026-10-27 --commit <sha> --bundle-sha256 <hex> --open-all`.
   The journal records both; every trial's trace records the commit
   (`YTIMESY_HARNESS_COMMIT`). Nothing on the hosts is edited after init.

## 3. Valid, infra and retries

As `docs/tb4-scoring-rule.md` section 2, plus:

- Retried (infra), at most 3 extra attempts per trial (CPU) / 4 (GPU), the controller's
  attempt caps: the container, host or environment failed to start; the host died,
  rebooted or became unreachable; the grader environment failed or produced no reward
  (including Harbor rejecting a verifier's network policy); a provider API error,
  throttle or refusal that the transport guard could not recover and that ended the agent.
- Never retried, scored as is: anything the agent did. A wrong answer, a crash in its own
  code, giving up, the agent time limit (scored 0) and the spend cap (scored 0).
- Every infra attempt is journaled with its reason and listed by name in the report.

## 4. Spend

| Item | Number | Basis |
|---|---|---|
| Expected model spend | $2,150-2,500 | Reason's Astra tokens x5 x1.15 = $2,145; mean of Reason and Codex trials x1.15 = $2,493 (OpenAI list price, x1.15 for Bedrock in-Region and cache writes) |
| Per-trial cap | per task, `scripts/tb4-run/astra-trial-caps.json` -> `/opt/tb4/trial-caps.json` | max(2 x the most expensive public trial, 3 x the mean) x1.15, at least $6, at most $100 (bridge maximum); `run-trial.sh` exports it and writes `trial-cap.txt` |
| Total model cap | $2,400 hard: `TB4_MODEL_TOTAL_CAP_USD=2400`, `TB4_MODEL_STOP_MARGIN_USD=300` | the watchdog stops new launches at $2,100 settled so running trials finish under $2,400; each host's bridge ledger (`YTIMESY_HARBOR_TOTAL_USD_CAP=2400`) is the backstop |
| Infra | 4 x m7i.16xlarge ($3.2256/h) + 5 x p5.4xlarge (price to confirm: `TB4_P5_4XL_HOURLY_USD`) + t3.small, ~10 h | `TB4_INFRA_CAP_USD` set from the confirmed p5 price |

The expected model spend is at or above the $2,400 cap at the high end: if the run is as
expensive as Codex's trials, the cap stops launches before every task has 5 trials and those
tasks are reported incomplete ("budget stop"), never padded.

Ledger reservations: the bridge reserves a trial's cap before inference on its host's
ledger. A CPU host runs at most ~15 trials under the CPU budget; even with the largest caps
($100 x 3 tasks, $78, $64, ...) its open reservations stay under $1,500, inside the $2,400
host ledger. The global stop uses settled spend summed over hosts.

## 5. Monitoring and the pre-committed early stop

`controller.ts score --codex benchmarks/evaluation/codex-astra-public-job.json --reason-job benchmarks/evaluation/reason-astra-public-job.json`
reports at any time `bounds.floorPct` (every missing scored trial counted as a fail) and
`bounds.ceilingPct` (counted as a pass), and where we stand against Codex and Reason.

The run stops early only by these two gates, fixed before launch (decided 2026-10-27). The
controller evaluates them on every tick with `TB4_EARLY_STOP=on` (`earlyStopGates` in
`scripts/tb4-run/lib.ts`, tested in `tests/tb4-run.test.ts`) and logs each evaluation to its
journal (`gates: ...`). A stop means no new launches: in-flight trials finish and are collected,
and the journal records `type: "gate"` and `type: "stop"` with the reason.

- Decisive set: the 16 `TB4_PRIORITY_TASKS` CPU tasks (Codex passes each 1-4 of 5).
- Gate A: once the first scored trial (earliest agent start among the task's valid scored
  trials; infra outcomes never count) exists for at least 15 of the 16 decisive tasks
  (ctr-optimization may still be running), count our passes among those first trials.
  5 or fewer: stop, reason `early-stop gate A: <n>/<m> decisive first-trial passes <= 5`.
  6 or more: gate A is passed for good (journaled once, never evaluated again).
- Gate B, at any time: the ceiling over the 63 CPU tasks falls below Codex Astra's pass@1 on
  the same 63 tasks: stop, reason `early-stop gate B: ...`.
- Otherwise the run completes; the budget caps (section 4) still apply. Being ahead never stops
  the run, and a stopped run is reported as stopped, with the scores of the trials it has.

## 6. Baselines (public, labeled as such)

- Codex CLI 0.151.0 + GPT-6 Astra xhigh, Harbor Hub job `caf6e433`, 5 trials per task:
  57.9% (`benchmarks/evaluation/codex-astra-public-job.json`).
- Reason Agent 1.2 (BYOK) + GPT-6 Astra xhigh, public Harbor Hub trials, 3 per task: 59.1%
  (`benchmarks/evaluation/reason-astra-public-job.json`).
- Their runs used Harbor's hosted infrastructure on other dates; ours uses EC2 Docker hosts.
  We do not rerun them.

## 7. Integrity

- After the run, `node --import tsx scripts/tb4-run/hack-audit.ts <results-root> --out review.jsonl`
  lists every passing trial whose web searches or fetches target the benchmark, the task's
  solution or tests, or whose commands touch test, grader, oracle or reward files (subagents
  included). A person reviews each flag; a trial is scored 0 only on evidence, and every such
  trial is listed.
- Verifiers with `allow_internet = false` (`batched-eval-parity`, `lake-temp-glm`) run with
  Harbor's Docker egress-control sidecar (`deny-all`). It needs the host kernel's
  `CONFIG_NFT_FIB_INET`; `bootstrap.sh` fails a host without it. Docker Desktop's linuxkit
  kernel lacks it, so those two tasks cannot be graded on a Mac.

## 8. Reporting (results private until the user decides to publish)

- pass@1 = mean over the 66 tasks of passes / 5; 95% bootstrap interval over tasks; paired
  difference vs Codex and vs Reason with a seeded paired bootstrap 95% interval and tasks
  better / worse / tied. "Better" is claimed only when the paired interval is above 0;
  otherwise "same score" with the cost comparison.
- Cost per task at OpenAI list price from tokens (uncached, cached, output; subagents and
  search requests included, `openaiDirectUsd`), plus the actual Bedrock bill; tokens per task;
  wall time per task; a cost-vs-score plot.
- Disclosed: subagents (helpers and writers, how often each started), web search and fetch,
  effort, instance types and resources, Harbor version, frozen commit and bundle hash, every
  infra attempt, extra valid trials not scored, tasks at the attempt cap, amendments.
- Trajectories stay on our hosts and R2; publishing to Harbor Hub is a separate decision.

## Amendments

None.

## Model rate limits (no quota increase)

Bedrock lists Astra limits only for the cross-region profiles (4M tokens/min each); the
mantle route this run uses has no published Astra limit. Instead of a quota increase:
- `TB4_MAX_IN_FLIGHT=30` caps trials in flight across the fleet (16 at once ran clean on
  2026-10-27). Raise it in steps of 10 only after 30 minutes with no `throttle` lines in the
  hosts' transport logs.
- A throttled model request (429, or a 5xx before any output) is resent with backoff and
  Retry-After for up to 4 minutes per attempt (signed-request lifetime); the SDK's re-signed
  retries each get the window again (about 20 minutes in all).
- A trial whose last model call still failed is classified infra and retried under the
  retry rule, never scored 0.

## Frozen settings (2026-10-27 evening)

- Variant: `codeMode=on,plan=on,helpers=write,fetch=on,search=function`; `checks` at its default `full`
  (no check-in-proportion line: it stopped hard, target-driven tasks after the first passing check),
  plus the unattended rule that a reported problem is never closed as intended (98d6ce7).
- Model `openai.gpt-6-astra`, effort xhigh, Bedrock mantle, web search on.
- Caps: per-task caps from `astra-trial-caps.json`; `TB4_MODEL_TOTAL_CAP_USD=2900`,
  `TB4_MODEL_STOP_MARGIN_USD=300` (no new launches past $2,600 settled); `TB4_MAX_IN_FLIGHT=30`.
- Order: GPU tasks first when a GPU host exists; then `TB4_PRIORITY_TASKS`, the CPU tasks Codex
  passes only sometimes (they decide the score), longest first: ctr-optimization,
  live-database-cutover, takens-embedding-lean, lake-temp-glm, layout-config-recreation,
  vf2-speedup-networkx, cumulative-layout-shift, distributed-dedup, payments-pipeline-fix,
  biped-contact-dynamics, music-harmony, freecad-spring-clip, batched-eval-parity,
  session-window-debug, embedding-drift-monitor, mvcc-lsm-compaction. The early-stop check
  reads them first.
- GPU tasks (jax-speedrun-gpu, fp8-rmsnorm-gemm, math-eval-grader) run whenever p5.4xlarge
  capacity appears, with this same frozen commit; until then the score is reported on the 63
  CPU tasks against Codex and Reason on the same 63, GPU tasks marked pending.
