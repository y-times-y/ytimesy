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

## 2. Freeze and fingerprint

- Frozen harness: tag `tb4-astra-2026-10-27` = commit `8965702`, git tree
  `226f4ea0dde6409e50ea9d79edd17210f58ee440`. Hosts run it from source: the tagged tree
  (`git archive`, SHA-256 `41933ecac9b07b00ef0e41308d45aebe3d523ee3ad8bfe50ca2e931b09101527`) is
  extracted to `/opt/tb4/ytimesy` with `pnpm install --frozen-lockfile`, and `agent.py` starts the
  bridge as `node --import tsx evals/harbor_v2/bridge.ts` (`YTIMESY_BRIDGE_BUNDLE` unset).
- No bridge bundle: in an esbuild single-file bundle every module's `import.meta.url` is the
  bundle's, so `evals/harbor_v2/preflight.ts`'s command-line entry guard fires inside the bridge
  and its `parseArgs` rejects the bridge's JSON argument (every pipeline trial with the bundle
  ended "agent never started"). The fingerprint replaces the bundle hash: commit `8965702` +
  tree `226f4ea0...` + archive SHA-256 `41933eca...`. Every trial's trace records
  `harness.commit = 8965702` and `harness.version = tree:226f4ea0...` (`YTIMESY_HARNESS_VERSION`);
  the journal's `run-start` records the archive SHA-256 in its `bundleSha256` field.
- Every CPU host's 2,055 tagged files hash identically to the tag (checked 2026-10-28), and
  `/opt/tb4/check-trial-env.sh` (run under systemd like a trial) prints
  `TRIAL-ENV-OK commit=8965702 source=tree:226f4ea0...` before a host takes trials.
- The controller and host run scripts (`scripts/tb4-run/`: controller, early-stop gates,
  collection, cleanup, GPU capacity loop, `run-trial.sh`, `backup.sh`, `check-trial-env.sh`) run
  at a newer commit of branch `tb4-astra-run` (pushed to main), fixed after the tag by the
  pipeline trials. They schedule, collect and back up trials; none of them is part of the
  harness the model runs in, which is the frozen `8965702` tree.
- Init: `controller.ts init --run-id tb4-astra-2026-10-27 --commit 8965702 --bundle-sha256 41933eca... --open-all`.
  Nothing on the hosts' `/opt/tb4/ytimesy` is edited after init.
- Pipeline trials (`tb4-astra-pipeline-trial-*`, own run dirs, journals and ledgers) tested the
  path end to end; their results are never part of the scored run.

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

- 2026-10-28 ~02:40 UTC: Harbor 0.24.0's Docker egress-capability probe timeout raised from 30 s to
  300 s on every CPU host (and on any GPU host the capacity loop adds;
  `scripts/tb4-run/host/patch-harbor-probe.py`, original kept as `docker.py.orig-0.24.0`).
  Enforcement is unchanged: the probe still runs and offline verifiers still get the deny-all
  sidecar. Why: on a busy host the probe (a `docker run`) timed out, Harbor then rejected the
  offline verifier of `lake-temp-glm` b2-a02 after the agent ran; that attempt stays infra by the
  rule and is listed. Trials already running at the change keep the 30 s probe.
- 2026-10-28: a final model response is a provider failure (infra) only for HTTP 429 and 5xx
  (`lastModelCallFailed`); a 4xx such as 400 is the harness's own request and scores as the
  trial's graded result. `takens-embedding-lean` b2-a04 (Bedrock HTTP 400 after 46 ms on a
  ~174k-token request, well under Astra's input limit; the frozen harness logs no response body;
  the verifier graded the workspace: reward 0) is reclassified infra -> valid 0 by a journal
  `amend` event. Its retry b2-a05 started later than b2-a01..a04, so it is an extra valid trial,
  disclosed, not scored.
