# TB4 run controller

Scripts: `scripts/tb4-run/`. Scoring: `docs/tb4-scoring-rule.md`. Gate:
`scripts/tb4-readiness.ts` (docs/tb4-readiness.md). Lessons: docs/benchmark-lessons.md.

## Shape

- **Controller** (`t3.small`, 200 GB gp3, termination protection, root volume kept on
  termination, no TTL): runs `tb4-controller.service` (`controller.ts loop`),
  `tb4-watchdog.timer` (every 5 min) and `tb4-backup.timer` (results to R2 every 5 min).
  State is one append-only, fsynced journal `/opt/tb4/run/journal.jsonl`.
- **CPU hosts** (4 x `m7i.16xlarge`, 1 TB gp3 each) and **GPU host** (1 x `p5.4xlarge`,
  1 H100): Docker + Harbor 0.24.0 + the frozen repo/bundle at `/opt/tb4/ytimesy`. Each
  trial is `run-trial.sh <task> <attempt-id>` under `systemd-run` (unit
  `tb4-trial-<attempt-id>`) with Harbor's local `docker` environment, writing
  `/opt/tb4/jobs/<attempt-id>/`. The bridge runs on the host; Bedrock calls go from there.
- **Scheduling**: `nextLaunches` packs trials by task vCPU/memory onto healthy hosts
  (Docker NCPU = nproc, >= 100 GB free), GPU tasks first and only on the p5, at most one
  GPU trial at a time; never more in flight than a task still needs. Per-host
  concurrency follows the host CPU budget below.
- **Host CPU budget** (`fitsCpu` in `lib.ts`, tested in `tests/tb4-run.test.ts`): each
  trial keeps its full task CPU allocation. On every host,
  `sum over in-flight trials of (task cpus + 1) <= host vCPU - 2`. Task cpus come from
  each `task.toml` as `max([environment].cpus, [verifier.environment].cpus)` (a separate
  verifier runs on the same host after the agent); the +1 per trial covers the Harbor
  CLI, our bridge and agent loop and docker exec on the host; the 2 reserved vCPU cover
  dockerd, sshd, backup and the watchdog. An idle host always takes one trial, so
  `jax-speedrun-gpu` (16 cpus) still runs alone on the 16-vCPU p5. On an m7i.16xlarge
  (64 vCPU) that is at most 20 two-cpu trials. Why: in the 2026-10-21 preflight,
  `retro-console-soc` failed its oracle with ~32 tasks on one host and passed on an
  idle host. That host's load (94 task cpus on 192 vCPU, 96 physical cores, plus 31
  image pulls at once) was within this rule, so the rule removes CPU oversubscription
  but does not by itself prove retro-console-soc is safe; rerun it when its host is
  lightly loaded if it fails again.
- **tasks.json**: `controller.ts tasks --run-dir <dir>` reads every `task.toml` from
  Harbor's dataset cache (`~/.cache/harbor/tasks/packages/terminal-bench/<task>/<hash>/`,
  the cache `preflight.ts` and `run-trial.sh` use; run `harbor download` or a preflight
  first) or from `--dataset <dir>` (`<task>/task.toml`).
- **Resume**: the journal records `launch` before the ssh launch. On restart `tick`
  replays it and, per unfinished attempt: result present -> collect; host unreachable ->
  wait; host rebooted since launch -> infra; unit still active -> adopt; unit gone with no
  result -> infra. Attempt ids are deterministic and `run-trial.sh` refuses an existing
  job dir, so no trial runs twice and none is lost.
- **Results**: rsync to the controller (`/opt/tb4/run/results/<id>`), then R2 (second
  copy, `backup.sh`). The IAM user cannot use S3, so R2 holds the off-machine copy (the
  rerun's practice). Hosts keep their copy until teardown.
- **Spend**: each host's bridge ledger `/opt/tb4/ledger.jsonl` (trial cap $12, total
  $900); the watchdog sums all ledgers and at $900 touches `ledger.jsonl.stop` on every
  host and journals `stop`. AWS Budget (below) is the account-wide net.

## Run book

```sh
cd scripts/tb4-run
python provision.py plan
python provision.py up --dry-run --key-name harbor-runner --sg <sg>   # free; all 6 launches pass (2026-10-21)
python provision.py up --run-id tb4b-<date> --key-name ... --sg ... --subnet ...
python provision.py hosts --run-id tb4b-<date> > hosts.json            # scp to controller /opt/tb4/run/
# on each host: copy the frozen repo + bundle to /opt/tb4/ytimesy, /opt/tb4/run.env, Bedrock creds (scp, 0600)
# run.env: YTIMESY_HARBOR_ROUTE=bedrock YTIMESY_HARBOR_APPROVED=bedrock YTIMESY_HARBOR_MODEL=openai.gpt-6.1-sol
#   YTIMESY_HARBOR_EFFORT=max YTIMESY_HARBOR_VARIANT=lead=fusion,review=on,checkerMode=single,rigor=on,
#   roleModels.writer=openai.gpt-6-luna,roleModels.checkerWorker=openai.gpt-6-luna,roleModels.classifier=openai.gpt-6-luna
#   (exact role keys per the bedrock route on harbor-bridge-v2 once merged)
#   YTIMESY_HARBOR_TRIAL_USD_CAP=12 YTIMESY_HARBOR_TOTAL_USD_CAP=900 YTIMESY_BRIDGE_BUNDLE=... YTIMESY_HARNESS_COMMIT=...
# controller: install systemd/*.service|timer, /opt/tb4/watchdog.env (TB4_ALERT_WEBHOOK), /opt/tb4/backup.env (R2)
node --import tsx scripts/tb4-run/controller.ts init --run-id tb4b-<date> --commit <sha> --bundle-sha256 <hex>
echo tb4b-<date> > /opt/tb4/run/run-id
sudo systemctl enable --now tb4-controller.service tb4-watchdog.timer tb4-backup.timer
node --import tsx scripts/tb4-run/controller.ts status | score
node --import tsx scripts/tb4-run/controller.ts open-batch b2 --owner <name>   # refuses unless the rule says go
python provision.py down --run-id tb4b-<date> --confirm tb4b-<date>          # after the R2 copy is verified
```

## Failure causes and the review gate

Why: on 2026-10-28 a harness bug (the context-window lookup from openrouter.ai failed
under load, the 128k fallback led to a fatal compaction error) ended 65 trials with
`builder stopped: The model request failed without a usable provider reason...` in
`agent/ytimesy-bridge.log`. The verifier graded the unfinished workspace, the controller
journaled each as a plain valid 0, and nothing paused: the first one landed ~1 h in, ten
by ~2 h 15 m, and gate B stopped the run at 3 h after ~$1,900. Reading the first failing
log would have stopped it at ~$200.

The score does not change: `classify` still decides valid/infra, and a trial our harness
broke is still a scored 0 (our product failed). What changes is that spending stops and
the operator looks.

- **Cause** (`failureCause` in `lib.ts`): every `finish` of a non-pass carries
  `cause: { cause, detail, failedTests? }`, derived from the collected trial dir
  `results/<attempt>/<attempt>/<task>__<id>/` (`agent/ytimesy-bridge.log`,
  `verifier/ctrf.json`, `result.json` `exception_info`). Details are sanitized
  (credential-looking strings redacted, control characters dropped, <= 300 chars).
  Journals written before this change have no `cause` and still replay.

  | Cause | Evidence | Review |
  |---|---|---|
  | `agent-finished` | bridge log present, no stop line; detail = failed tests from `ctrf.json` | no (benign) |
  | `agent-timeout` | `exception_info` `AgentTimeoutError` (graded at the time limit) | no (benign) |
  | `agent-stopped-abnormally` | a `builder stopped:` / `bridge failed before or outside the trial:` / `refused:` line, an uncaught exception, another exception type, or `Model provider failed` lines | yes |
  | `budget-cap` | the stop line is the trial spending cap, the request limit, the total cap or the ledger stop file | yes |
  | `verifier-error` | `exception_info` type mentions Verifier/Reward | yes |
  | `infra:<reason>` | the classify infra reason (host restart, no reward, launch failed, ...) | yes |
  | `unknown` | reward 0 and no bridge log or exception | yes |

  `agent-timeout` is benign because a hard task running to its limit is normal (the public
  baselines hit it too); everything else either spends money unexpectedly or means a
  broken setup. `TB4_REVIEW_BENIGN` overrides the list.
- **Review gate**: a non-benign cause journals `review-needed` and every new launch waits
  (trials in flight keep running and are collected). The watchdog sends a critical ntfy
  alert per pending review every hour until it is acked.

  ```sh
  node --import tsx scripts/tb4-run/controller.ts failures --run-dir /opt/tb4/run   # every non-pass + cause, by finish time (--json)
  less /opt/tb4/run/results/<attempt>/<attempt>/<task>__*/agent/ytimesy-bridge.log    # read the log itself
  node --import tsx scripts/tb4-run/controller.ts ack <attemptId> --note "read: <what it was, why it is safe to go on>"
  node --import tsx scripts/tb4-run/controller.ts ack all --note "..."             # every pending review at once
  node --import tsx scripts/tb4-run/controller.ts status                           # reviewsPending, stage1
  ```

  `ack` refuses without `--note` or for an id that is not pending. `resume` clears only a
  `pause`, never a review. For a journal from before causes existed, `failures` derives
  causes from `results/<attempt>` and marks them `(derived)`.
- **Error spike**: `TB4_SPIKE_COUNT` (default 3) abnormal ends within `TB4_SPIKE_MINUTES`
  (default 30) journal `stop` with the reason `error spike: ...` (a stop, not a pause: it
  holds even if someone acks the reviews). Counted: every non-benign cause except
  `infra:*` (one dead host ends many trials at once, and infra attempts are retried, not
  scored). `TB4_SPIKE_COUNT=0` turns it off. The stop does not kill trials in flight.
- **Staged scaling** (`TB4_STAGE1`, on unless `0`/`off`): with batch 2 open (`init
  --open-all`), only batch 1 (one trial of every task) launches. When every scheduled task
  has its batch-1 trial finished (valid, or at the attempt cap), the controller journals
  `stage-review`; batch 2 starts only after `controller.ts ack stage1 --note ...`. An early
  `ack stage1` (before every stage-1 trial is done, e.g. while the 8 h GPU task still runs)
  releases batch 2 at once. Priority, front-load, exclude and `TB4_MAX_IN_FLIGHT` keep their
  meaning inside each stage (front-loaded tasks get their batch-1 trial first, their batch-2
  trials first after the ack); excluded tasks never hold stage 1. A journal that already
  has batch-2 launches is never held.
- **Settings** (controller environment, e.g. a systemd drop-in for tb4-controller.service):
  `TB4_REVIEW_GATE` (on; `off` journals causes but never holds), `TB4_REVIEW_BENIGN`
  (`agent-finished,agent-timeout`), `TB4_SPIKE_COUNT` (3), `TB4_SPIKE_MINUTES` (30),
  `TB4_STAGE1` (on).

## Preflight: outside dependencies and long context

Both checks run on one capped smoke trial before any scored launch.

**(a) Everything but the model API blocked.** The bridge must still start and resolve the
right context window with no outside service other than the model endpoint (the
2026-10-28 failure was an openrouter.ai lookup failing and a silent 128k fallback).

```sh
# on the smoke host: a guard that tunnels only to the model API host
node --import tsx scripts/tb4-run/faults/fault-proxy.ts --egress-allow <model host, e.g. bedrock-mantle.us-east-1.api.aws> \
  --port 8788 --log /opt/tb4/egress.log &
# smoke run.env additions (bridge only; Docker pulls are not proxied):
#   HTTPS_PROXY=http://127.0.0.1:8788 HTTP_PROXY=http://127.0.0.1:8788 NODE_USE_ENV_PROXY=1 NO_PROXY=127.0.0.1,localhost
/opt/tb4/run-trial.sh <short task> preflight-egress-1
node --import tsx scripts/tb4-run/faults/fault-proxy.ts --verify-egress /opt/tb4/jobs/preflight-egress-1/preflight-egress-1/<task>__* \
  --egress-log /opt/tb4/egress.log --model-host <model host> --expect-window <the model's window, e.g. 400000>
```

Pass = exit 0: the bridge log has no `builder stopped:` / `bridge failed` line, at least
one request to the model host went through the guard (otherwise the bridge bypassed the
proxy and the check proves nothing: Node needs `NODE_USE_ENV_PROXY=1`, Node >= 22.21 or
24), and the bridge log's last `context window <tokens>` line equals the expected window.
The verdict lists every blocked destination (each is an outside dependency to remove or
to add to the checklist below). Offline tests: `tests/tb4-run.test.ts` "tb4 egress preflight".

Harness hook needed: the bridge does not log its resolved window yet. The harness must
write one line to stderr (`agent/ytimesy-bridge.log`) once the model runtime is built,
matching `context window <tokens>` (e.g. `context window 400000 (catalog)` or
`context window 128000 (fallback)`); `contextWindowFromLog` reads the last one. Until it
does, `--verify-egress` fails with "the bridge log has no context window line".

**(b) One turn past the compaction threshold.** Not offline-testable from the controller;
plan:

1. Scripted rehearsal first (no model spend): the harness's mock-model trial tests
   (`tests/harbor-v2-trial.test.ts`) with the runtime's context window set to the
   production value and its lookup failing (fetch rejects for every host but the model),
   and a tool result that pushes one turn past the compaction threshold (e.g. a command
   printing ~1.2x the threshold in tokens). Pass: compaction runs and the builder
   continues; the trace shows the compaction step; no `builder stopped:`.
2. Then one capped real smoke under the egress guard above, on a task whose agent reads a
   large file in one turn (or a scratch task that `cat`s a generated ~600 KB file), with
   `--expect-window` set. Pass: (a) passes, the trace shows a compaction, and the trial
   ends `agent-finished` in `controller.ts failures` (or passes).

## Before paying for a run

Every outside dependency and limit, verified the day of the run, before any spend:

- **Instance limits and GPU quotas, per provider**: AWS EC2 vCPU quotas per family
  (Standard L-1216C47A; P instances) minus what other sessions already run, p5 capacity
  in the region (a DryRun is not capacity), Nebius instance limit, Modal GPU caps, Daytona
  GPU limit (1 at a time on our account). Fleet size and `TB4_MAX_IN_FLIGHT` must fit.
- **Spending and usage limits, and when charges land**: AWS Budget alarms (account-wide;
  Bedrock and Marketplace charges show up hours later, so the ledger, not the bill, is the
  live number), the bridge ledger caps (`YTIMESY_HARBOR_TRIAL_USD_CAP`, per-task caps,
  `YTIMESY_HARBOR_TOTAL_USD_CAP`) and the watchdog's `TB4_MODEL_TOTAL_CAP_USD` /
  `TB4_MODEL_STOP_MARGIN_USD`, infra cap and `TB4_P5_4XL_HOURLY_USD`.
- **Credits remaining**: AWS credits, OpenRouter credit, Modal and Daytona credits, any
  search/fetch provider credit the variant uses.
- **Model API rate limits**: Bedrock requests- and tokens-per-minute quotas for the exact
  model and region, at the planned concurrency (30 trials plus subagents), not one trial.
- **Subscription usage limits**: if any route or helper uses a subscription (Codex plan
  5 h and weekly windows), it will run out under parallel load.
- **Other outside services the trial touches**: model catalog lookups (openrouter.ai),
  web search/fetch providers, Docker Hub / registry pull rate limits for task images,
  Harbor's dataset registry, R2 (backup), ntfy.sh (alerts). Preflight (a) above must pass:
  nothing but the model API on the critical path.
- **Stage-1 review**: run with `TB4_STAGE1` on; read every stage-1 failure in
  `controller.ts failures` and its bridge log before `ack stage1`.
- **Read every failure's log as it lands**: each `review-needed` alert means a log to
  read, not a box to tick; the ack note says what it was. Do not `ack all` unread.

## Alerts (no new paid service)

The watchdog POSTs to an [ntfy.sh](https://ntfy.sh) topic: free, no account. Pick an
unguessable topic (`openssl rand -hex 16`), put `TB4_ALERT_WEBHOOK=https://ntfy.sh/tb4-<hex>`
in `/opt/tb4/watchdog.env`, and subscribe in the ntfy app (iOS/Android) or at
`https://ntfy.sh/tb4-<hex>` in a browser; email forwarding is available by adding the
header `Email: hetkp16@gmail.com` (ntfy's free tier allows a few emails a day). Alerts
carry counts and attempt ids only. Repeats of one alert are held 60 min. SNS email was
the alternative but the `harbor-runner` user cannot use SNS.

Watchdog checks: controller service active (restarts it), 20 min log silence per trial,
host health, Bedrock 429/Throttling >= 20 in 15 min (pauses launches) and 5xx >= 10,
model spend at 50/80/100% of $900 (100%: stop), infra spend at 50/80/100% of $560
(100%: pause), no trial finished in 60 min, every pending review (critical, until acked),
a stopped run (critical), and an info line per finished batch of trials.
Re-arming test: `sudo systemctl kill tb4-controller` -> the next watchdog run restarts it;
`systemctl list-timers | grep tb4` shows the timers (Persistent, survive reboot).

## Spend numbers

| Item | Number | Why |
|---|---|---|
| Expected models | $360-500 / 330 trials | ~$1.1-1.5 per trial (user estimate) |
| Bridge trial cap | $12 | ~8x mean; the bridge reserves it per trial before inference |
| Bridge total cap (per host) + global stop | $900 | 1.8x the high estimate; reservations of ~60 concurrent trials (~$720) fit under it |
| Infra expected | $300-560 | 4 x m7i.16xlarge $3.23/h + p5.4xlarge (price to confirm) + controller $0.02/h |
| AWS Budget (monthly, account-wide) | $1500, email at 50/80/100% actual + 100% forecast | models + infra high end ($1060) + margin |

`provision.py budget --email hetkp16@gmail.com` creates it. On 2026-10-21 `harbor-runner`
was denied `budgets:ModifyBudget` (and SNS, S3, Cost Explorer, IAM): run it with an admin
profile (`TB4_AWS_PROFILE=<admin>`) or attach `scripts/tb4-run/iam-tb4-operator.json`.

## Capacity found 2026-10-21

- EC2 DryRun launches of all 6 fleet instances (incl. p5.4xlarge) succeed with key
  `harbor-runner` and SG `harbor-runner-ssh`.
- The Standard-family vCPU quota is 384; two `c7i.48xlarge` (`tb4-preflight-cpu`, another
  session) already use all of it, so even a t3.micro launch failed with
  `VcpuLimitExceeded`. The CPU fleet (256 vCPU) needs those stopped or a quota increase
  (L-1216C47A).

## Failure injection (docs/tb4-readiness.md item 3)

`scripts/tb4-run/faults/fault-proxy.ts` injects one fault on the Nth request between the
bridge and Bedrock: `reset` (connection dropped mid-response), `cut` (SSE closed before
its terminal event, no error), `throttle` (429 `ThrottlingException`), `outage` (every
request refused for N s). Offline tests prove each fault's wire behavior and the
controller's handling (host restart -> infra + rerun; graded trial kept; attempt cap;
unreachable host -> wait; throttle -> pause). Against a capped smoke trial later:

| Case | Inject | Pass |
|---|---|---|
| Dropped connection | proxy `--fault reset --nth 3` | guard resends and the trial grades, or `exception_info` set -> infra; never a silent 0 |
| Stream cut | proxy `--fault cut --nth 3` | `transport.log` shows the resend and a terminal event |
| Host restart | `ssh host sudo reboot` 5 min into the agent phase | journal: `finish infra "host restarted during the trial"`, a new attempt launched, no orphan unit |
| Bedrock throttle/limit | proxy `--fault throttle --nth 2` (then 25 in a row for the watchdog) | the guard backs off and retries, or the trial raises (infra); watchdog pauses launches at 20/15 min |
| Network outage | proxy `--fault outage --outage-sec 300` | recovers after retry, or a clean infra failure with the error class logged |

Not offline-testable now: the bridge reading a base-URL override for the Bedrock route
(needed to put the proxy in the path; SigV4 signs the Host header, the proxy keeps the
upstream Host), and the in-container H100 assertion (`run-trial.sh` records host
`nvidia-smi` as a stopgap; the bridge should assert inside the container).
