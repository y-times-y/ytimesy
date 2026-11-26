# User limits and concurrency

What one signed-in user can run at the same time, and every limit that bounds
them. Read from code and configuration on 2026-11-26. Numbers marked
*(provider)* come from a provider's plan or dashboard, not from this
repository, and change with the plan. Values that are environment settings
show their code default; production may set another.

## 1. Concurrency (threads running at once)

A "thread" is a chat with a turn running. Chats are independent: each has its
own Durable Object (the coordinator), its own queue of turns and, mostly, its
own workspace VM.

| Limit | Value | Where | What happens at the limit |
|---|---|---|---|
| Running turns per user | 32 (`YTIMESY_USER_TURN_CONCURRENCY`, range 2-64) | `src/server/adapters/agent-capacity.ts`, `claimApiTurn` in `api-turns.ts` | Further turns stay `queued` and start by themselves, oldest first, when one finishes |
| Running turns platform-wide | 256 (`YTIMESY_FLEET_TURN_CONCURRENCY`, range 2-10,000) | same | Same queue, across all users |
| Turns per chat | 1 running; the rest wait | one turn per chat; `agent_peer_inbox` | Messages sent meanwhile queue behind the turn or steer it |
| Queued messages per chat | 50 | `QUEUED_MESSAGES_PER_CHAT_LIMIT`, `src/domain/peer-inbox-injection.ts` | A send past it is refused with an error |
| Turns started per Super agent turn | 8 `start_thread` calls | `Y_SQUARED_MAX_STARTS_PER_TURN`, `src/domain/y-squared.ts` | The tool answers "Not started" and the agent tells the person what is left |
| Threads in the Super agent's overview | 25 | `Y_SQUARED_THREAD_LIMIT` | Most recently active first; older ones are counted, not listed |
| Live checker workers per judge | 3 (1 on the judge's own model) | `src/domain/checker-pair.ts` | Further workers wait |
| Helper chats (subagents) | admitted by depth, live children, tree size and budget | `subagentAdmission`, `agent-capacity.ts` | The start is refused with a capacity message |

There is no cap on how many chats or threads a user may *create*; only the
running-turn limits above and the budgets below bound them.

**Claiming.** A turn is queued in Postgres (`api_turn`). Admission takes one
queued turn at a time under a database advisory lock, only when the user has
fewer than the per-user limit running and the platform fewer than the fleet
limit. A forked chat's turn waits until its VM copy is bound.

**Where a turn runs.**

- In its chat's Durable Object (the default and the fallback). No box limit
  applies.
- On an AWS turn runner box, when the user is enabled for boxes
  (`YTIMESY_BOX_TURN_USERS`), the turn is an API-key, Codex or Grok turn, and a
  box registered in the last 45 s. The fleet is an Auto Scaling group of
  2 to 6 `t3.small` boxes (`infra/alchemy/aws.run.ts`), scaling at 60% average
  CPU with a 3 minute warm-up. Each box runs 6 turns (`YTIMESY_TURN_BOX_CAPACITY`,
  1-32). So box turns are bounded by 12 (2 boxes) to 36 (6 boxes) at once; a
  turn that finds no room runs in its Durable Object instead, so a full or
  down fleet does not strand it. A box that dies has its turns taken over after
  45 s, at most 3 times (`docs/turn-runner-boxes.md`).
- Claude Code turns (a Claude subscription) run `claude` on the chat's own VM or
  on a runner box (`docs/claude-code-placement.md`). Per turn, at most
  2,000 model requests (`CLAUDE_CODE_TURN_REQUEST_CAP`).

**Budget holds.** When a user's monthly Cloudflare budget is reached
(opt-in, `docs/cloudflare-budget.md`) or their platform usage window is used
up, the turn stays queued and that user's other turns wait too, so one user
does not starve the rest. The Super agent tells the person "Queued ... behind
the budget/concurrency limit; it starts by itself when there is room."

**Super agent (Y²) wakes.**

| Cap | Value | Where |
|---|---|---|
| Event wakes per project per hour (a finished turn, a started thread) | 60 | `CREW_WAKES_PER_HOUR`, `y-squared-crew.ts` |
| Hard ceiling per project per hour, including needs-you and failed | 120 | `CREW_URGENT_WAKES_PER_HOUR` |
| Proactive wakes (schedules, stall nudges, reminders) per rolling 24 h | 48 | `Y_SQUARED_PROACTIVE_WAKES_PER_DAY`, `y-squared-proactive.ts` |
| Wakes per user per day, all projects | 600 | `Y_WAKES_PER_USER_PER_DAY`, `y-default.ts` |
| Active schedules per project | 10, never more often than every 30 min | `Y_SQUARED_SCHEDULE_LIMIT` |
| Stall reminders | 3 per wait, one per 3 h | `WAITING_REMIND_*` |

A comment next to the proactive cap still mentions a 24 per hour event cap;
the constant in force is 60 (see `y-squared-crew.ts`).
A wake into a Super agent that is mid-turn is held up to 5 minutes, then
queued behind the turn. A plan more than 90% used (a Claude plan) skips the
wake.

## 2. Machines (Freestyle and our own caps)

| Limit | Value | Where | What the user sees |
|---|---|---|---|
| Machines on the account | 200 *(provider, Hobby)* | Freestyle | A start gets 429 `LIMIT_EXCEEDED` ("Account resource limit exceeded"); we retry and the chat shows "Starting machine..." |
| Running machines at once | 40 *(provider, Hobby)* | Freestyle | Same: the next start waits for a slot |
| Storage | 3,125 GB *(provider, Hobby)*; binds before 200 machines at 32 GiB each (97) | Freestyle | Same |
| Disk per VM | up to 64 GB on Hobby *(provider)*; our VMs use 32 GiB; new VMs start at 2 vCPU, 4 GiB, 16 GiB | `CHEAP_BASE_RESOURCES`, `product-vm.ts` | A resize past the ceiling is refused |
| Runtime per VM | a native cap set from the user's funded time (observed 2,628 s on one VM on 2026-11-25) | `usage-admission.ts` | The VM stops at the cap; the next operation buys more, or is refused when the user's window is used up |
| Snapshots | 1,000 *(provider)* | Freestyle | Not used for idle chats (recycling is stopped) |
| New machines per user per hour | 60, fixed window | `USER_ACTION_LIMITS["vm-create"]`, `src/domain/user-action-rate.ts` | "This account started too many new machines in the last hour. Wait a few minutes, then retry; your work is preserved." A create the provider refuses is refunded, so retries do not spend the count |
| Machines per user | no count cap found; each chat has one workspace VM, helpers may share it | | Bounded by the account limits above |
| Idle pause | 60 s without traffic; 180 s after a background command | `PRODUCT_IDLE_TIMEOUT_SECONDS`, `BACKGROUND_IDLE_TIMEOUT_SECONDS` | A paused VM resumes in about a second |
| Auto delete | 30 days without running | `PRODUCT_AUTO_DELETE_SECONDS` | Older VMs paused before 2026-11-12 keep 90 days until they next run |
| Command waits | 600 s per command, 300 s per exec | `COMMAND_WAIT_MAX_SECONDS`, `FREESTYLE_EXEC_TIMEOUT_MS_MAX` | The command continues in the background |
| Background job time | 30 minutes per job run | `JOB_TIME_LIMIT_MS` | The job resumes |

Observed on 2026-11-26 (read-only list): 49 machines, 4 running, 44 paused,
1 stopped.

### 2a. Freestyle account limits (API and public docs, read 2026-11-26)

Sources: read-only `GET /v5/vms` and `GET /v5/snapshots` on the account, the
public OpenAPI (`api.freestyle.sh/openapi.json`), and
`freestyle.sh/pricing` and `/docs/vms/pricing-and-limits`. **The API has no
endpoint that returns plan name or quotas** (no limits, usage or billing path
in the OpenAPI); the plan is read from the dashboard, or inferred from the
caps: 40 running, 200 saved, 1,000 snapshots and 3,125 GB are exactly the
Hobby column. Usage comes from `GET /v5/vms` (`runningCount`, `totalCount`,
per-VM `resources`) and `GET /v5/snapshots` (`totalCount`).

| Limit | Free | Hobby (ours) | Pro | Enforced | Scope |
|---|---|---|---|---|---|
| Price | $0 | $50/month, includes $50 of usage | $500/month, includes $500 of usage | | |
| Concurrent VMs (running, starting or pausing; paused ones do not count) | 10 | **40** | 400 | hard, 429 | account |
| Saved VMs (all, running or not) | 10 | 200 | 4,000 | hard | account |
| Snapshots (ones we create) | 10 | 1,000 | 12,000 | hard | account |
| Total vCPU (running VMs) | 40 | 800 | 16,000 | hard | account |
| Total memory (running VMs) | 80 GiB | 1.56 TiB | 31.25 TiB | hard | account |
| Total disk (every saved VM, running or not) | 320 GB | **3,125 GB** | 62,500 GB | hard | account |
| Max per VM: vCPU / memory / disk | 4 / 8 GiB / 32 GB | 8 / 16 GiB / 64 GB | 32 / 64 GiB / 256 GB | hard (400 on a create or resize) | VM |
| Data transfer included | 50 GB | 500 GB | 500 GB | billing | account |

Usage prices (all plans, per hour of allocated resource): vCPU $0.04032,
memory $0.0129 per GiB, storage $0.000086 per GiB, transfer $0.02 per GB.
Monthly included on every plan: 200 vCPU-hours, 400 GiB-hours of memory,
60,000 GiB-hours of storage. On Hobby and Pro the plan fee is spent against
usage dollar for dollar; above it usage is billed. On Free the allowances are
hard stops. A paused VM holds no vCPU or memory, only storage. Enterprise:
custom limits, contact sales (cal.com/freestyle/enterprise-onboarding).

Observed in the account (2026-11-26, after the retention job ran):
32 machines (3 running or starting, 29 paused), 1,024 GiB of machine disk
(32 GiB each), 22 snapshots. Against Hobby that is 3 of 40 running, 32 of 200
saved, about 33% of the 3,125 GB disk. On 2026-11-25 the account held 98
machines at about 3,120 GiB.

**Disk is the limit that bites first.** The saved-VM cap of 200 cannot be
reached at 32 GiB per VM: 3,125 GB holds 97 such machines (Freestyle's own
table: 97 on Hobby, 1,953 on Pro). The 429 `LIMIT_EXCEEDED` "Account resource
limit exceeded" on 2026-11-25 18:33-18:41 UTC came with 98 machines and 4
running, so neither 40 running nor 200 saved: it was the total-disk budget
(99.8% used; the next 32 GiB machine did not fit). Our own guard now refuses
above 95% (`docs/workspace-retention.md`).

**Is 40 running a hard limit?** Yes. The OpenAPI documents `429
LIMIT_EXCEEDED: your plan's limit for this resource is reached` on
`POST /v5/vms`, and the docs say the request is rejected with an error naming
the limit. The 41st machine to start or be created gets that 429; the chat
shows "Starting machine..." while we retry for up to 15 minutes (honouring
`Retry-After` when sent, capped at a minute). Nothing is billed extra and no
other machine is touched. Paused machines do not count. We have not provoked
the running-cap 429 on purpose (it would need 41 machines); the evidence is the
API contract, the plan table and the storage-cap 429 above, which uses the same
code. Capacity can also answer 409 ("no capacity is available") and 429
("server is at capacity") with a different message.

**Runtime cap on a VM ("2628/2628 s").** `maxRunTotalSeconds` is a lifetime
running-seconds budget on one VM, `totalRunSeconds` is what it has used across
every run. It is not a plan limit and it never resets by itself: spending it
pauses the VM, and every later start is a 409 until the budget is raised with a
VM update. We set it per VM from the user's funded time
(`usage-admission.ts`); the next operation raises it or is refused when the
user's window is used up. Separate per-VM fields: `maxRunSeconds` (one run;
starting again gives a fresh budget; we use 3,600 s on some), `ttlSeconds`
(delete after creation) and `autoDeleteSeconds` (delete after that long
paused; some plans cap it, we set 30 days).

**Not published or not readable.** Freestyle publishes no request-rate limits
(per second or minute) for create, start or exec, no concurrent exec or
connection limit, no build limit apart from the snapshot count, and no region
limits; the API returns `Retry-After` on a 429 (the header is exposed) and we
honour it. Ask Freestyle before planning on any of these. Snapshot disk is not
returned by the list API.

**How to raise.** Disk, running and saved caps: upgrade Hobby to Pro ($500 a
month, 400 running, 4,000 saved, 12,000 snapshots, 62,500 GB), or an
Enterprise plan for custom numbers. Shrinking what each user keeps (fewer
saved machines, shorter retention, smaller disks) raises headroom without
paying.

#### Budget per power user

Assumptions: a power user keeps 8 saved chat machines at 32 GiB (256 GiB),
runs 2 at once for 4 hours a day for 30 days (240 VM-hours), on the 2 vCPU /
4 GiB base size ($0.132 per VM-hour); storage billed 730 hours a month; peak
running is 2 per user (everyone at once). Cost is usage at list rates minus
the monthly included allowances ($18.38), never below the plan fee. Machines
at 4 vCPU / 16 GiB cost $0.368 per hour, about 2.8 times the compute line.

| Users | Running (peak) | Saved | Disk | Compute / month | Storage / month | Hobby ($50) | Pro ($500) |
|---|---|---|---|---|---|---|---|
| 1 | 2 | 8 | 256 GiB | $32 | $16 | fits, $50 | fits, $500 |
| 10 | 20 | 80 | 2,560 GiB | $317 | $161 | fits (82% of disk), about $460 | fits, $500 |
| 50 | 100 | 400 | 12,800 GiB | $1,587 | $804 | no: 40 running, 200 saved, 3,125 GB | fits, about $2,370 |
| 100 | 200 | 800 | 25,600 GiB | $3,174 | $1,607 | no | fits (50% of running, 20% of saved, 41% of disk), about $4,760 |

On Hobby, disk allows 12 such users (3,125 / 256), running allows 20, saved
allows 25. For 100 users the cost is about $4,760 a month on Pro, roughly $48
per user, of which two thirds is compute while awake. Storage alone for kept
machines is about $16 per user per month, so 100 users hold 25,600 GiB.
These are estimates, not a quote; real usage depends on the share of time
machines are awake.

## 3. Model usage

- **Platform usage window.** The platform's own included cloud usage is
  metered per user in two rolling windows, a short one (5 hours) and a longer
  one (7 days), in micro-dollars of compute. The first use after a window ends
  starts the next; its reset time is fixed then. An exhausted window refuses
  new turns, subagents and VM starts for that user (a running VM's own turn may
  finish). Defaults are deployment settings (`YTIMESY_USER_5H_MICRO_USD`,
  `YTIMESY_USER_WEEKLY_MICRO_USD`) and an administrator can override them per
  user. A fleet-wide monthly and lifetime ceiling also apply
  (`docs/infrastructure-usage.md`).
- **Referral.** A qualified referral gives both accounts a fresh window. A
  referrer earns at most 3 in 30 days and 12 in total; decisions run at most
  2 a day per referrer (`docs/referral.md`). It never changes a plan the user
  connected.
- **Plans the user brings** (Codex, Claude, Grok subscriptions): their limits
  are the provider's. Up to 5 accounts per provider
  (`MAX_ACCOUNTS_PER_PROVIDER`); when one is limited the turn moves to another
  account or model. Failover: at most 3 switches per turn, and at most 2
  hops past a fallback that cannot serve at all, then the turn fails and lists
  what was tried (`src/domain/model-failover.ts`).
- **API keys:** the provider's own rate limits and credit apply. Our daily
  token safety budgets: 150,000,000 per account, 40,000,000 per task tree,
  2,000,000 for memory work (`api-usage-budget.ts`, overridable by
  `YTIMESY_API_*_DAILY_TOKENS`); a turn that would pass one is refused.
- **Sends:** 20 chat messages per minute per user, 10 new projects per hour
  (`user-action-rate.ts`). The test-account mint limit is for tests only.
- **Output tokens:** 8,192 per reply by default, 64,000 for Claude.

## 4. Cloudflare and database limits that bound us

- Workers Paid included usage must cover all users: 400,000 GB-s of Durable
  Object duration, 1M Durable Object requests, 10M Worker requests and 30M CPU
  ms a month (`docs/turn-runner-boxes.md`). A Durable Object is billed while it
  is awake, so a long turn waiting on a model is the largest cost; turn runner
  boxes exist to move that wait off it.
- Duration spend cap: a hard cap is now set on the account (the dollar value is
  an account setting, not in the repository). Observed duration, 2026-11-20 to
  11-26 (GB-s per UTC day): 7.8k, 16.2k, 11.9k, 33.6k, 122.2k (11-24), 87.9k,
  3.2k (partial). The peak days came from the turn-startup incident
  (`docs/turn-startup-incident-2026-11-24.md`).
- Per-user monthly budget (opt-in): 4,000 GB-s duration, 10k Durable Object
  requests, 100k Worker requests, degrade at 70% (`docs/cloudflare-budget.md`).
- WebSockets: 16 tabs per user hub (`MAX_HUB_SOCKETS`); the hub remembers
  500 chats; one hibernatable socket per box turn; a socket message bills at
  1/20 of a request.
- Postgres: one pool per process, `DATABASE_POOL_MAX` default 2 (1-20),
  10 s to acquire, 20 s per statement, 30 s idle in a transaction
  (`docs/database-capacity.md`). The pooler's connection count, not the user
  count, is the ceiling. Turn admission is serialized by one advisory lock.
- R2: no per-user cap is enforced in code; checkpoints are capped at 48 MiB
  (`checkpoints/storage.ts`).
- GitHub: App installation tokens are cached (200); a 403 rate limit fails
  fast instead of waiting inside a Durable Object. Git bundles are capped at
  64 MiB.

## 5. Other per-user limits

| Item | Limit | Where |
|---|---|---|
| New projects | 10 per hour | `user-action-rate.ts` |
| Chats, projects, repositories per project | no count cap found in code | |
| Attachments per message | 8 files, 10 MiB each, 20 MiB total | `MESSAGE_ATTACHMENT_LIMITS` |
| Canvas | 500,000 characters, title 60 | `src/domain/canvas.ts` |
| Canvas notes | 30 per send, 2,000 characters each | `canvas-annotation.ts` |
| Project knowledge | 120,000 characters | `project-knowledge.ts` |
| Message from the Super agent to a thread | 8,000 characters | `Y_SQUARED_MESSAGE_LIMIT` |
| Allowed domains per project | 50 | `vm-network-policy.ts` |
| Plan steps | 30 | `plan-tool.ts` |
| Goal | 8,000 characters, 6 continuations | `goal.ts` |
| Secrets | description 500 characters; no count cap found in code | `project-secret.ts` |
| Captains | planned (5 per project); not in code yet | |
| Subscription accounts | 5 per provider | `subscription-accounts.ts` |
| Output kept from a command | 50 KB / 2,000 lines shown; 16 MiB stored | `lean-output.ts`, `agent-output-artifacts.ts` |

## 6. How many threads can one user keep running

| Users | Running at once | First limit to bite |
|---|---|---|
| 1 | up to 32 admitted; about 10-15 is comfortable | The user's own platform usage window and their model plan's window, then Freestyle running machines if other work is on |
| 10 | about 10-15 each is possible only below 40 running machines | Freestyle running machines (40) and box slots (12-36) |
| 100 | far below 32 each | Machines (200), Durable Object duration spend, Postgres pool and the admission lock |

What to change for 10-15 threads per user without interruptions, in order of
impact:

1. Freestyle plan with a higher running-machine cap (or a request to raise the
   40 and 200). Cost: plan fee plus usage; not code.
2. Keep turns off Durable Objects: enable boxes for everyone and raise the
   fleet maximum (6 boxes x 6 turns = 36) in proportion to users. `t3.small`
   is about $15 a month each on demand, paid from credits.
3. Raise the usage windows for heavy users per user (administrator override)
   and watch the fleet ceilings.
4. Show the queue: today a held thread only shows a note; a visible "waiting
   for a slot" state with a position would remove the surprise.
5. Pool and pooler size: raise `DATABASE_POOL_MAX` only with a measured
   connection budget.
