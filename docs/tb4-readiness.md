# TB4 readiness gate

No scored Terminal-Bench 4.0 trial starts until every item below is PASS and its
evidence is recorded in the run notes. The gate exists because the 2026-10-12..14 run
(66 tasks x 5 trials) lost about a day to infrastructure: a Modal spend limit, 60-150 GB
jax workspaces failing Harbor's Daytona transfer, OpenAI streams cut mid-response, one
Daytona H100 at a time, a laptop low-battery sleep, a 5 h monitoring lapse, an AWS
account verification hold and Freestyle's dockerd caching NCPU at start
(docs/benchmark-lessons.md, benchmarks/evaluation/tb4-rerun-20261013.md).

Run the automatable part:

```sh
node --env-file=.env --import tsx scripts/tb4-readiness.ts \
  [--bridge ../cloud-bridge2] [--route codex-subscription] \
  [--variant lead=fusion,review=on,checkerMode=single,rigor=on] \
  [--run-env <controller env file>] [--rule benchmarks/evaluation/tb4-<run>.md]
```

It prints PASS / FAIL / MANUAL per check with evidence and the command for anything it
cannot check, and writes `.ytimesy/tb4-readiness/<ts>/report.json`. It never calls a
model, never launches or changes a cloud resource and never prints a secret. AWS calls
are read-only (Service Quotas, Bedrock list/availability) with the `harbor` profile. Exit
status is 1 while any check FAILs. MANUAL items are closed by a person recording the
evidence named below; the gate is open only with 0 FAIL and 0 MANUAL.

The harness under test is bridge v2 (`evals/harbor_v2`, docs/harbor-bridge-v2.md):
`lead=fusion` (one sidekick in the lead's checkout), `review=on` with
`checkerMode=single` or `pair`, `rigor=on`. Several writers (`subagents=on`) are refused
by the bridge.

## Items

### 1. Per-task preflight

- **Verify**: `evals/harbor_v2/preflight.ts --tasks <all 66>` on the exact environment
  each task will be scored on (GPU tasks on the AWS p5 host, the rest on the CPU hosts).
  Then one capped real-agent trial per task class (item 2) through the real grader,
  including the largest workspace (`jax-speedrun-gpu`: 147 GB `/app` in the rerun) and
  the "agent hit its time limit" path.
- **Pass**: every task has `passed: true` (oracle reward exactly 1, nop exactly 0, no
  exception) in a preflight file no older than 7 days, built with Harbor 0.24.0 and the
  pinned task images; the jax workspace reaches the grader with a matching byte count.
- **Evidence**: the preflight JSON path and `at`; per-task oracle/nop job names; for
  jax, `/app` size, transfer manifest status and verifier reward.
- **Script**: dataset count, task classes (GPU / MCP / sidecar / large disk from
  `task.toml` and `environment/docker-compose.yaml`), preflight coverage and age.

### 2. Our harness on the real container, per task class

- **Verify**: a capped real-agent smoke (`--agent-timeout-multiplier 0.125`, 1 trial) of
  the exact scored config on one task per class: CPU (`atrx-vep-crispr` or any), GPU
  (`fp8-rmsnorm-gemm` on p5), MCP (`medical-claims-processing`), service sidecars
  (`ctr-optimization`), large disk (`jax-speedrun-gpu` on p5). Build the bridge bundle
  from a clean commit and set `YTIMESY_BRIDGE_BUNDLE` / `YTIMESY_HARNESS_COMMIT`.
- **Pass**: `result.json` has a numeric reward and `exception_info: null`;
  `agent/ytimesy-trace.json` `variant` contains `lead=fusion`, `review=on`, the planned
  `checkerMode` and `rigor=on`; review rounds ran with `checks[].restored: true`; the
  sidekick and checker rows appear in `efficiency.modelRows`; the trajectory validates
  under Harbor 0.24.0 (docs/harbor-bridge-v2.md step 3); the GPU trial asserts an
  H100 inside the container before the agent starts; the trace records the bundle
  SHA-256 and is unique per trial.
- **Evidence**: trial directories under `.ytimesy/tb4-readiness/smoke/`, bundle hash,
  commit, model rows and cost.
- **Script**: the bridge's `harborBridgeConfig` accepts the planned variant and the
  `checkerMode=pair` arm on the planned route; scans smoke job dirs for a graded trial
  with the planned variant per class (MANUAL until found).

### 3. Injected failures

Each is injected into a capped smoke trial (not a scored one). The scoring rule (item 8)
decides what a failure counts as.

| Failure | Injection | Pass |
|---|---|---|
| Dropped connection | fault proxy resets the provider TCP connection mid-request | guard retries and the trial completes, or the trial ends with `exception_info` set (infra, rerun), never a silent 0 |
| Stream cut mid-response | proxy truncates one SSE response before its terminal event | `transport.log` shows the resend and a terminal event; the agent never sees a partial response |
| VM/host restart | reboot the trial host during the agent phase | controller marks the trial infra (no reward) and reruns it; no orphaned sandbox or instance |
| Codex usage limit hit | subscription transport stub returns 429 `usage_limit_reached` | trial raises (exception, not a 0); controller pauses new trials until `wham/usage` clears |
| Network outage | block egress for 5 min | retry and recover, or a clean infra failure with the raw error class, status and request id logged |

- **Evidence**: per injection, the trial dir, `transport.log` lines, the classification
  `classify.py` assigned, and the controller log lines.
- **Script**: MANUAL; lists which bridge files and tests cover each failure synthetically.

### 4. Capacity

- **Verify**: hosts for 330 trials (one concurrent trial of every task needs about 224
  vCPU before separate verifiers); GPU tasks (`fp8-rmsnorm-gemm`, `jax-speedrun-gpu`,
  `math-eval-grader`) on AWS p5.4xlarge (1 H100, 16 vCPU each) in us-east-1; disk for
  the largest workspace; provider spend limits.
- **Pass**: us-east-1 quota L-417A185B (Running On-Demand P instances) >= 32 vCPU (an
  agent and its separate verifier at once), with the GPU wall-time estimate inside the
  run window; a test p5 launch succeeded in the last 7 days (no verification hold); the
  p5 host has >= 500 GB free local disk; Modal / Daytona / Freestyle billing limits each
  exceed the planned spend by 50%; Docker healthy on every host with `docker info .NCPU`
  equal to the VM's vCPU after any resize; Harbor 0.24.0 pinned on the controller.
- **Evidence**: quota values per region, launch test instance id and time (terminated),
  billing screenshots or numbers, host list with vCPU/disk.
- **Script**: p5 quota in us-east-1 and us-west-2 with the H100-hour estimate, local
  Docker health, Harbor 0.24.0 in the uv cache.

### 5. Model capacity and spend caps

- **Verify**: Codex subscription windows at start and the pacing plan (about 20 builder
  runs per 5 h window on Plus: 330 trials is about 17 windows unless upgraded; review and
  sidekick runs consume the same windows); Bedrock access for each Claude/OpenAI model
  the run uses, and a bridge route that can reach it; spend caps in the controller's
  environment.
- **Pass**: weekly window < 50% and the 5 h window not at its limit at start, with a
  usage gate between trials; every Bedrock model the config names is AUTHORIZED and
  AVAILABLE and the bridge has a route for it; `YTIMESY_HARBOR_TOTAL_USD_CAP`,
  `YTIMESY_HARBOR_TRIAL_USD_CAP` and `YTIMESY_HARBOR_SPEND_LEDGER` set (Bedrock is paid:
  the total is an owner-approved budget), no `<ledger>.stop`.
- **Evidence**: `wham/usage` percentages with time, Bedrock availability per model, cap
  values and the ledger path.
- **Script**: all of the above, read-only.

### 6. Controller off the laptop

- **Pass**: `harbor run` and the run loop execute on a server/VM with no auto-delete or
  TTL (`benchmarks/harbor/freestyle-coordinator.ts` sets none), under systemd or tmux;
  finished trials copied to R2 within 5 minutes; a second copy before anything is
  deleted. The laptop only reads.
- **Evidence**: VM id, unit name, R2 prefix and the sync log's last line.

### 7. Monitoring and ownership

- **Pass**: a cron/systemd timer on the controller (never a session reminder) that alerts
  on trial end, 20 minutes of log silence, spend crossing 50/80/100% of the cap, and a
  usage-limit pause; killing the watcher once shows it restarted; one named owner session
  in the run notes, all others read-only.
- **Evidence**: timer listing, the restart test, the owner line in the run notes.

### 8. Scoring rule fixed in advance

- **Pass**: `benchmarks/evaluation/tb4-<run>.md` committed before the first scored
  trial, stating: what is infra (agent never started, grading environment failed to
  build, host killed by the provider, a cut the guard could not recover, workspace not
  delivered to the grader) and is rerun, not scored; graded trials are never rerun; attempt
  caps per task; first 5 valid trials by agent start count; budget stop; providers per
  task; GPU model asserted inside each trial (void otherwise). Amendments are dated and
  committed before the trials they affect.
- **Script**: finds a committed `tb4-*.md` rule other than the 2026-10-13 rerun and audit
  files and checks it names rerun, scored, budget and attempt rules.

### 9. End-to-end dry run

- **Pass**: 3-5 tasks (one CPU, one sidecar, one MCP, one GPU on p5) run through the real
  controller, monitor, R2 sync, collection, `classify.py` and the scorer, producing the
  report format the scored run will publish, with cost per trial matching the ledger.
- **Evidence**: `.ytimesy/tb4-readiness/dry-run/report.*` plus the job dirs.
- **Script**: PASS when a dry-run report exists there, else MANUAL.
