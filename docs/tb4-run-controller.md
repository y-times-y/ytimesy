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

## Alerts (no new paid service)

The watchdog POSTs to an [ntfy.sh](https://ntfy.sh) topic: free, no account. Pick an
unguessable topic (`openssl rand -hex 16`), put `TB4_ALERT_WEBHOOK=https://ntfy.sh/tb4-<hex>`
in `/opt/tb4/watchdog.env`, and subscribe in the ntfy app (iOS/Android) or at
`https://ntfy.sh/tb4-<hex>` in a browser; email forwarding is available by adding the
header `Email: owner@example.com` (ntfy's free tier allows a few emails a day). Alerts
carry counts and attempt ids only. Repeats of one alert are held 60 min. SNS email was
the alternative but the `harbor-runner` user cannot use SNS.

Watchdog checks: controller service active (restarts it), 20 min log silence per trial,
host health, Bedrock 429/Throttling >= 20 in 15 min (pauses launches) and 5xx >= 10,
model spend at 50/80/100% of $900 (100%: stop), infra spend at 50/80/100% of $560
(100%: pause), no trial finished in 60 min, and an info line per finished batch of trials.
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

`provision.py budget --email owner@example.com` creates it. On 2026-10-21 `harbor-runner`
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
