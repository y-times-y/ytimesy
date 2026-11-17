# Cloudflare compute budget

Cloudflare Workers Paid has no hard cap (account spending limits are not exact), so ytimesy meters itself and holds new work before the included allowances are crossed.

## Off by default: who is budgeted

The per-user meter and budget are opt-in. `YTIMESY_CF_BUDGET_USERS` is a comma separated list of user ids (same style as `YTIMESY_BOX_TURN_USERS`); **empty or unset means off for everyone**. Two ways to enable it:

- Named users: `YTIMESY_CF_BUDGET_USERS=userid1,userid2`.
- Everyone: `YTIMESY_CF_BUDGET_USERS=*`.

For a user who is not listed there are no `usage_day` writes, no `UserHub.addUsage` calls, no budget read at admission (`budgetAdmission` never calls the hub), no degraded turns, no held turns and no budget notice in the chat. The check is an in-memory parse of the variable; with the list empty the chat object does not even read its identity.

The global kill-switch `YTIMESY_CF_BUDGET_GLOBAL=degrade|pause` is an operator switch and is **not** gated by the list: when set explicitly it applies to every user (and to non-essential background jobs), listed or not. Unset it is off. One more path ignores the list: a Cloudflare account spending-cap refusal from a chat stub still holds that turn, since that is the platform refusing, not this budget.

## Budgets (per user, per UTC month; sized for 100 heavy users)

| Resource | Included / 100 users | Hard (blocked) | Soft (degrade, 70%) |
|---|---|---|---|
| Durable Object duration | 4,000 GB-s | 4,000 GB-s (32,000 active s at 128 MB) | 2,800 GB-s (22,400 s) |
| Durable Object requests | ~10k | 10k | 7k |
| Worker requests | ~100k | 100k | 70k |

Env overrides: `YTIMESY_CF_BUDGET_DO_GB_SECONDS`, `_DO_REQUESTS`, `_WORKER_REQUESTS`, `_DEGRADE_PERCENT`; kill-switch `YTIMESY_CF_BUDGET_GLOBAL=off|degrade|pause` (`.env.example`). Pure logic: `src/domain/cloudflare-budget.ts`.

## What is measured

- `ModelConversation` (`src/server/edge/executor.ts`, `usage-meter.ts`): wall time of each alarm step (room alarm, parked-turn renewal, `advanceTurn`), alarm count, `fetch()` count and `webSocketMessage` count (billed as count/20). Kept in memory and written as one row update per step end to `usage_day(day, user_id, wall_ms, requests, ws_msgs, alarms)`. The user id is parsed from the DO's `conversation_identity` name (`[userId, sessionId]`).
- Roll-up: each chat sends its unsent deltas to the user's `UserHub` (`addUsage`) at most every 3 minutes and when it has no active turn after a step. The hub keeps `usage_month` in its own SQLite and exposes `usage()` (totals, GB-s, state, message). No Postgres.
- Billed DO requests = fetches + alarms + ceil(ws messages / 20).

## Enforcement (at turn admission)

Only for users in `YTIMESY_CF_BUDGET_USERS` (see above); the global switch applies to all.

`startClaimedTurn` (`background-jobs.ts`, used by the admission job and `/turn/start`) reads `UserHub.usage()` through `budgetAdmission`:

- `ok`: start normally.
- `degrade` (>= 70% of any budget, or global `degrade`): the turn starts, marked degraded in the chat (`startTurn(..., { degraded: true })`); a degraded Claude Code turn waits twice as long between steps. With the global switch on, non-essential background jobs (`maintenance`, `memory`, `pr-evidence`) wait 30 minutes per alarm.
- `blocked` (>= 100%, or global `pause`): the claim is released, the turn stays queued (that user is skipped for the rest of the pass so others are not starved), and "Monthly compute budget reached, resets on the 1st" is logged. A running turn is never killed.
- Unreadable hub: fails open and logs. Cloudflare's spending-cap errors on the hub or chat stub are treated as held with the same message.

## What is NOT measured / known gaps

- Idle in-memory time: a DO that stays resident without alarms still bills duration; the meter undercounts it. Calibrate against the GraphQL `durableObjectsPeriodicGroups` (duration per object) and adjust budgets or multiply wall time.
- Worker requests are not metered per user (the budget and state function support it; nothing feeds it yet). That includes the turn runner boxes' thin-client API (`/box/v1/*`, docs/turn-runner-boxes.md): `routeTurnBoxEdge` has a `countRequest(userId)` hook, unwired, because feeding the user's hub per request would add the Durable Object request it exists to avoid. A 40-step box turn is about 120 Worker requests and ~19 Durable Object requests (socket messages bill 1/20), against targets of ~100 and ~10 per turn. Box socket messages reach the chat's `webSocketMessage`, so they are already in `usage.record({ wsMsgs: 1 })`; the box HTTP routes (Worker only) are not.
- `BackgroundJobRunner` and `ProjectEnvironment` alarms are not metered: their objects are keyed by job/workspace, with no user id. Only the global switch affects background jobs.
- The legacy `/start` route does not consult the budget.
- The user-facing notice: the held turn simply stays queued and the message is in logs and `UserHub.usage()`; nothing in the chat UI renders it yet.
- Hub deltas are at-least-once: a lost acknowledgement can double count (the safe direction).

## Manual backstops

Set Workers and Durable Object spending limits in the Cloudflare dashboard, and billing email alerts at 50%, 70% and 90% of usage.
