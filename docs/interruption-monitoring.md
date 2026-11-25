# Interruption monitoring

Goal: see, every day and without anyone reporting it, how often a chat turn is interrupted (a deploy, a reset, a lost box) and whether the user saw it. Cheap by design: one small row per interruption, no new Worker cron, a canary that costs a few dozen tokens twice an hour.

Related: [Deploying while turns run](turn-runner-boxes.md#deploying-while-turns-run-2026-11-23), [Cloudflare budget](cloudflare-budget.md).

## What is logged

Table `interruption_event` (id, at, kind, turn_id, session_id, cause, recovered, user_visible), written by `reportInterruption(event)` in `src/server/services/interruption-monitoring.ts`. That is the one function for any code that notices an interruption; it never throws and waits at most 1.5 s, so it cannot fail or slow the action (AGENTS.md: bookkeeping never blocks).

Writes are bounded: at most one row per (kind, turn) per 10 minutes, checked in memory first (no query) and again inside the insert. Rows are pruned after 35 days by the daily digest.

Recorded today (hooks in `src/server/adapters/api-turns.ts`):

| kind | cause | recovered | user_visible | where |
|---|---|---|---|---|
| `turn-abandoned` | `executor-stopped` | no | yes | `abandonApiTurn`: the executor stopped driving the turn, the chat gets the error item |
| `turn-abandoned` | `lease-expired` | no | yes | `expireApiTurnLeases`: "The worker disconnected" |
| `lease-takeover` | `box-heartbeat-lost` | yes | no | `requeueInterruptedBoxTurns`: another box takes the turn after 45 s |
| `machine.rate_limited` | `<operation> attempt <n>` | yes | no | `resumableMachineStart`: Freestyle answered 429 (also the log line `machine.rate_limited`, JSON: operation, slug, attempt, retryAfterMs, detail) |

**Not yet recorded (another builder owns the files).** `src/server/jobs/api-turn.ts` already logs `turn.interrupted` (cause `reset`, `connection`, `edge-outage`), `src/server/jobs/box-runner.ts` and the executor handle delayed starts. They should call `reportInterruption({ kind: "turn.interrupted", turnId, cause, recovered: true, userVisible: false })` next to the existing `console.warn`, and a delayed start `{ kind: "delayed-start", ... }`. `queued_message.restored` (`src/server/adapters/queued-user-messages.ts`) and `queued_message.restore_failed` (`src/server/services/queued-user-messages.ts`) can do the same with their kind names. Until then, count those from the logs (below).

Log signatures to search in the Cloudflare edge/web logs and the box journal:
- `turn.interrupted` (JSON: turnId, step, stage, cause, executor): a step hit a reset or cut connection and is retried from its checkpoint.
- `queued_message.claimed`, `queued_message.delivered`, `queued_message.restored`, `queued_message.restore_failed`: the waiting-message lifecycle; `restore_failed` is the bad one.
- Lease takeovers: `lease-takeover` rows (above); a box turn is handed over at most 3 times (`MAX_BOX_TURN_TAKEOVERS`).
- Delayed starts: a turn queued long before a claim (admission held, no box free).

## Where to see the daily count

- Email: the **daily digest** goes to the owner address (`YTIMESY_ALERT_EMAIL`, default het@ytimesy.com) at 07:00 UTC, about the previous UTC day: total, user-visible, recovered, counts by kind/cause, the six days before, and canary runs/failures. Pure logic: `src/domain/interruption-report.ts`.
- SQL: `select date_trunc('day', at) d, kind, cause, count(*), count(*) filter (where user_visible) from interruption_event group by 1,2,3 order by 1 desc;`
- Alert: any user-visible interruption emails the owner (kind `interruption`, key = UTC hour), so at most one email per hour.

Owner alerts only send in production (`YTIMESY_ENVIRONMENT=production`) or with `YTIMESY_OWNER_ALERTS=true`.
`turn-abandoned` also triggers the older `abandoned-turns` alert from the same sweep, so one incident can email twice in the same hour.

## How it is scheduled (no new cron)

`wrangler.edge-executor.jsonc` already runs a cron every minute; its `infrastructure` maintenance job runs every 5 minutes. A step `interruption-monitoring` was added to that job (`background-job-delivery.ts`). Each tick it only compares the clock: the digest runs at 07:00-07:04 UTC (the `owner_alert` row for the day is the claim, so it sends once), the canary step runs when configured. The step catches its own errors, so it never fails the job.

## Synthetic canary

Inert until configured. It needs, set as edge-executor Worker secrets/vars (the same place as `YTIMESY_CODEX_EGRESS_PROBE_USER_ID`):

| name | what |
|---|---|
| `YTIMESY_CANARY_USER_ID` | id of a dedicated synthetic user account (not a real person) |
| `YTIMESY_CANARY_PROJECT_ID` | a project of that account (any tiny repo; one environment build) |
| `YTIMESY_CANARY_MODEL_ID` | the listed model id the chat sends with: the cheapest model that account has a connection for |

The account must have a working model connection (an API key it owns, with a low spend limit) and owner alerts must be enabled. No code reads a secret for it; the model key lives in the account like any user's.

Flow (`runCanaryStep`, two phases so no cron invocation waits on a model):
1. On minutes divisible by 30 (`CANARY_EVERY_MINUTES`), if no run is pending: send A ("Reply with exactly: PONG-A-<nonce>") into the canary's own chat, then B at once. B queues behind A's running turn (the queued-message path) and is delivered when A ends. The chat is reused between runs, so the send also wakes a chat that idled for 30 minutes (the paused VM / parked object path). A `canary_run` row is written with `ok = null`. A new chat is created when the old one passes 200 items.
2. On each later tick the pending run is checked against the chat's items (`canaryVerdict`): both messages present, both answered with their token, order A, answer A, answer B (B's message after A), **no error item**. Pass sets `ok = true`. An error item, or a missing piece 8 minutes after the send (`CANARY_LATENCY_BOUND_MS`), sets `ok = false` and emails the owner (`canary-failed`, once per hour).

Limits of the design: latency is checked at 5-minute tick granularity (a pass is recorded at the first tick that sees both answers); a run needs the canary project's environment, so the first send boots its VM and later wakes pay a VM resume; it cannot be avoided because the turn tools run there. It does not exercise box turns unless the synthetic user is listed in `YTIMESY_BOX_TURN_USERS`; list it to cover the box path.

## Cost

- Interruption rows: one insert (plus at most one dedupe check inside it) per interruption and kind/turn per 10 minutes, so a deploy storm of N turns is N rows. Roughly nil next to turn writes.
- Digest: one select per day plus one prune, one email.
- Cron: no new trigger, no new Durable Object; the extra step is an in-memory clock check per 5 minutes when nothing is due.
- Canary: 48 runs per day, two replies of about 10 output tokens plus the harness prompt (a cheap model, cents per month), 3 Postgres queries per tick while a run is pending (about 3 ticks), and 1 per tick otherwise. Worker request cost: none beyond the existing cron tick (see [Cloudflare budget](cloudflare-budget.md); the canary user is not metered unless `YTIMESY_CF_BUDGET_USERS` includes it). The synthetic user's turns do count as Durable Object duration and VM time; if that matters, set the canary to every hour by changing `CANARY_EVERY_MINUTES` to 60.

## Tests

`pnpm exec vitest run src/domain/interruption-report.test.ts src/domain/canary-timeline.test.ts src/server/adapters/interruption-events.test.ts src/server/services/interruption-monitoring.test.ts`

## Why the canary is still off (2026-11-25)

It needs a project, and a project needs a GitHub repository. The test account (`ytimesy-test-account`,
docs/testing-live.md) has no GitHub connection or repository, creating repositories is forbidden, and it has no
model connection. To turn it on: connect the test account to GitHub with one tiny repository, add a cheap API key as
its model connection, then set `YTIMESY_CANARY_USER_ID=ytimesy-test-account`, `YTIMESY_CANARY_PROJECT_ID` and
`YTIMESY_CANARY_MODEL_ID` on the edge Worker and deploy. Until then the daily digest (07:00 UTC) and the
user-visible alert are the live signals, and `interruption_event` is the record.

## Machine start limits (2026-11-25)

Evidence: 18:33-18:41 UTC, 4 chats retried `POST /v5/vms` and got 429 `LIMIT_EXCEEDED` "Account resource limit exceeded" (an account resource cap, not a request rate; 32+ hits in about 5 minutes). Each retry also spent one of the owner's 60 `vm-create` counts, so the 60/hour count (ours) ran out and the chats showed "too many new machines". Fixes: a failed create gives its count back; a machine refusal is waited out by the turn's 15-minute step retry; each hit logs `machine.rate_limited` and records an `interruption_event`. Not done: a global cross-isolate queue and an alert before the cap (needs a shared counter).
