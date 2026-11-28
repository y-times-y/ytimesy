# Infrastructure overview: how it works, limits, capacity and cost at scale

Written 2026-11-28 for the founder: how everything works, what the limits
are, how much we can deliver, and where cost grows as we add users. It builds
on [Limits](limits.md), [Architecture](architecture.md),
[Turn runner boxes](turn-runner-boxes.md),
[Interruption-proofing](interruption-proofing.md),
[Workspace retention](workspace-retention.md),
[Infrastructure as code](infrastructure-as-code.md),
[Cloudflare budget](cloudflare-budget.md) and [Y](y.md), and corrects them where
new measurements disagree.

**Budget:** under about $1,000 a month total at 100 power users, runway to
September 2027.

**How to read the numbers.** *Measured* means read today from production (a
read-only count, a provider API or Cloudflare analytics). *Estimate* means
measured usage multiplied by a list price, or an assumption that is stated.
All prices are list prices before credits. Model costs are not included,
because users pay for them through their own plans (see section 4.6).

## The short answer

| Question | Answer |
|---|---|
| How many users today | About **2-3 heavy power users** like today's one, or about **10-12 typical** ones (8 kept machines each). Freestyle's disk limit is reached first. |
| How many threads at once | Up to **40 threads using a machine** at the same time (Freestyle Hobby), **256 turns** platform-wide, and 12 turns on AWS boxes today (36 at most). The one power user peaks at 5-10 running turns. |
| What breaks first | (1) Freestyle disk (3,125 GB, 55% used today by essentially one user). (2) The Cloudflare Durable Object spend cap, at roughly 4 heavy users if the cap is about $10. (3) Freestyle 40 running / 200 saved machines at 20-40 users. (4) The database connection path (5 Hyperdrive connections, 60 on Supabase) at about 30-100 users. |
| Cost at 100 power users | **About $11,300 a month with today's defaults. About $1,220 with the cost-down design. About $700 with the cost-down design plus smaller machines and fewer Durable Object seconds.** Only the last one fits the budget. |
| Cost at 1,000 power users | About $112,000 a month (today's defaults); about $12,200 (cost-down); about $7,000 (cost-down plus). |
| Each extra user costs | About $110 a month with today's defaults; about $12 cost-down; about $7 cost-down plus. |
| Spend today | About $780 a month at list prices. Cash out is about $30, because credits cover Freestyle and AWS. |

The biggest single fact: **workspace machines default to the Large size**
(4 vCPU, 16 GiB; `DEFAULT_MACHINE_SIZE = "large"` in
`src/domain/machine-size.ts`). 50 of the 54 machines in the account are that
size. An hour of Large costs $0.368, against $0.132 for Small, so the earlier
estimates in [Limits](limits.md#budget-per-power-user), which assumed Small,
understate today's cost about 2.2 times.

## 1. How it works

```text
 Browser (web app)                                  ytimesy CLI
      │  HTTPS + live updates (WebSocket)               │
      ▼                                                 ▼
 ┌──────────────────────── Cloudflare (always on, pay per use) ────────────────────────┐
 │ Web Worker: pages, sign-in, server functions, admits new turns                      │
 │ Edge executor Worker + cron every minute                                            │
 │   ├─ ModelConversation Durable Object: one per chat; coordinates the turn, streams  │
 │   ├─ BackgroundJobRunner DO: short jobs (admission, checkpoints, PR repair)         │
 │   ├─ ProjectEnvironment DO: builds a project's machine snapshot                     │
 │   ├─ YSquaredCrew DO (Super agent) and UserHub DO (per-user tabs, usage)            │
 │ Hyperdrive ──► Supabase Postgres      R2: chat checkpoints, database backups        │
 │ VPC egress binding (Codex fallback)   Email binding (sign-in email)                 │
 └──────┬───────────────────────────┬───────────────────────────┬──────────────────────┘
        │ the turn's model loop runs either…                    │ tools touch the code on…
        ▼                           ▼                           ▼
 in the chat's Durable Object   on an AWS turn box          Freestyle VM (one per chat,
 (default and fallback)         (2-6 t3.small, us-east-1;   writers get their own fork):
                                 API key, Codex, Grok)      checkout, terminal, desktop,
                                                            Claude Code runs here
        │ model requests
        ▼
 Model providers, paid by the user:
   Codex (ChatGPT plan) ─► AWS egress proxy (1 t4g.nano, us-east-2), Cloudflare VPC as fallback
   Claude plan ─► Claude Agent SDK on the chat VM (or a Claude runner box: 2 t3.small, us-east-2)
   API keys and Grok ─► provider APIs, called from the edge
 GitHub App: repositories, branches, pull requests.  PostHog: product analytics.
 Alchemy (infra/alchemy): describes the Workers, bindings and the AWS turn box fleet as code.
```

**One message, end to end.** The browser sends the message to the Web Worker.
The Worker records the turn in Postgres (through Hyperdrive) as `queued`.
Admission checks the per-user (32) and platform (256) limits and starts it in
the chat's Durable Object. That object runs the turn itself, or hands it to an
AWS turn box when the user is enabled for boxes. Each model step goes to the
user's own provider. Codex goes through the egress proxy, because ChatGPT
refuses plain Cloudflare traffic. When the model calls a tool (run a command,
edit a file), the call goes to the chat's Freestyle VM, which resumes from
pause in about a second. Progress is saved to Postgres after every step, and
checkpoints go to R2. When the turn ends, the work is committed and pushed to
GitHub, and the VM pauses after 60-180 s idle.

| Platform | Responsible for | Always on, or only when used | State it holds |
|---|---|---|---|
| Cloudflare Workers | web pages, API, sign-in, routing | on demand, billed per request and CPU time | none |
| Cloudflare Durable Objects | one coordinator per chat, jobs, Super agent, per-user hub | wake when used; billed while awake (GB-s) | live turn state, small SQLite per object |
| Cloudflare cron | every-minute housekeeping | always (once a minute) | none |
| Hyperdrive | connection pooling from Cloudflare to Postgres | always | none (caching is off) |
| Supabase Postgres | the source of truth: users, chats, turns, admission | **always on** (Pro plan) | everything durable (696 MB today) |
| R2 | chat checkpoints, database backups | storage always, requests on use | about 12 GB |
| AWS turn boxes | run model loops off Cloudflare | **always on**: 2 minimum, up to 6 | none (saved to Postgres each step) |
| AWS Codex egress proxy | sends Codex requests from a fixed IP address | **always on**, 1 machine | none |
| AWS Claude runner boxes | optional home for Claude Code runs | **always on**, 2 machines (set up by hand, not in Alchemy) | temporary |
| Freestyle VMs | each chat's workspace: code, terminal, desktop, browser | **only when used**: pause after 60-180 s; disk is billed while kept | the working tree (until pushed), up to 30 days |
| GitHub | code, branches, pull requests | GitHub's | the users' code |
| PostHog | product analytics | on use | events |
| Email (Cloudflare Email) | sign-in and notification email | on use | none |
| Alchemy | infrastructure as code (`scripts/infra.ts`) | only when we deploy | its state in a Cloudflare Durable Object |

## 2. Limits

**Hard** means the platform refuses. **Soft** means we can change it
ourselves (a setting, a plan step, or an overflow path). Usage was read on
2026-11-28.

### Cloudflare

| Limit | Value | Hard / soft | Known how | Usage now |
|---|---|---|---|---|
| Durable Object duration included | 400,000 GB-s a month, then $12.50 per million | soft (billed) | provider plan | **~592,000 GB-s in Nov 1-27**: about 10-14k GB-s a day normally, with peaks of 122k and 88k GB-s on the 11-24/25 incident days |
| Durable Object duration **spend cap** | a dollar cap set on the account (the value is an account setting) | **hard**: once reached, objects refuse work and turns stay queued | account setting | already above the included amount this month; see section 3 |
| Durable Object requests | 1M a month included, then $0.15 per million | soft | provider plan | ~370k in November (13-24k a day) |
| Worker requests | 10M a month included, then $0.30 per million | soft | provider plan | ~2.1M in November (55-140k a day) |
| Worker CPU | 30M ms a month included, then $0.02 per million ms | soft | provider plan | ~30M ms in November: at the included amount |
| One alarm or cron run | stops after 15 min | hard | provider | designed around it |
| Deploys | restart every Durable Object | hard | provider | turns resume from checkpoints |

Which objects use the time (2026-11-21 to 11-27, GB-s): BackgroundJobRunner
153k (mostly the incident days), ModelConversation (chats) 96k,
ProjectEnvironment 29k, YSquaredCrew (Super agent) 13k, UserHub 4k. On normal
days chats account for about 80%.

### Database path (Hyperdrive, Supabase)

| Limit | Value | Hard / soft | Known how | Usage now |
|---|---|---|---|---|
| Hyperdrive connections to Postgres (production) | **5** (`origin_connection_limit`) | soft (a setting), but it caps how many queries run at once | measured (Cloudflare API) | ~300,000 queries a day for one heavy user |
| Hyperdrive query caching | off | setting | measured | |
| Postgres connections (`max_connections`) | **60**, which matches Supabase's smallest compute size (Micro) | hard per compute size; a bigger size raises it | measured | 19 open |
| Pool per request | 2 connections, 10 s wait | soft (`DATABASE_POOL_MAX`) | code | |
| Supabase plan | Pro, $25 a month, includes Micro compute, 8 GB disk, 250 GB egress | soft (plan) | **assumed**: the management API refused our token; Micro is inferred from the 60 connections | database 696 MB (8.7% of 8 GB) |
| Data read out of Postgres (egress) | 250 GB a month included, then $0.09 a GB | soft | provider plan | Hyperdrive results 0.4 GB a day after the November read cuts (up to 28 GB a day on incident days) |
| Turn admission | one database advisory lock for the whole platform | soft (code) | code | |

### AWS

| Limit | Value | Hard / soft | Known how | Usage now |
|---|---|---|---|---|
| Turn box fleet | 2-6 `t3.small`, scales at 60% CPU | soft (Alchemy setting) | measured: the fleet is at 2 | 2 running, 3 turns running |
| Turns per box | 6 (`YTIMESY_TURN_BOX_CAPACITY`; a `t3.small` fits about 8-10) | soft | code; the fit is an estimate | |
| Box turns at once | 12 (2 boxes) to 36 (6 boxes); a full fleet sends turns back to Durable Objects | soft | code | 15% of turns ran on boxes in the last 30 days (705 of 4,666); about half since 11-24 |
| Codex egress proxy | **1** `t4g.nano` with one fixed IP address, one region | soft, but a **single point** (the VPC fallback exists) | measured | serves all Codex traffic |
| Claude runner boxes | 2 `t3.small` | soft | measured | |
| EC2 vCPU quota for the account | not readable with our key | unknown | not measured | |
| **Leftover benchmark machines** | 5 stopped (4 × m7i.16xlarge and a controller) with about **4,200 GiB of disk** | n/a | measured | billed for disk only: about $336 a month, plus about $20 for 408 GiB of snapshots |

### Freestyle (workspace machines)

| Limit (Hobby plan) | Value | Hard / soft | Known how | Usage now |
|---|---|---|---|---|
| Total disk across all kept machines | **3,125 GB** | **hard** (refuses with 429); our own guard refuses at 95% | provider docs plus the 11-25 429 | **1,728 GiB (55%)**, 54 machines at 32 GiB each |
| Machines running at once | **40** | **hard** (429) | provider docs | 3 |
| Machines kept | 200 | hard | provider docs | 54 |
| Snapshots | 1,000 | hard | provider docs | 23 |
| Machine size used | default **Large: 4 vCPU, 16 GiB, 32 GiB disk** | soft (our code) | measured: 50 of 54 are Large | |
| Auto-delete | 30 days unused; Super agent auto-archive (on a branch, not deployed) | soft | code | |
| Next plan | Pro, $500 a month: 400 running, 4,000 kept, 62,500 GB | plan step | provider pricing | |

### Model providers (not ours, but they bound users)

| Limit | Value | Hard / soft | Known how |
|---|---|---|---|
| ChatGPT, Claude and Grok plans | each provider's own usage windows per account | hard per account; we fail over to another of the user's accounts (up to 5 per provider) or another model | provider |
| API keys | each provider's rate limits and credit | hard per key | provider |
| All Codex traffic from one IP address | not published by OpenAI | **unknown**: risk of throttling or blocking at volume | assumed |
| Our daily token safety budgets | 150M per account, 40M per task tree | soft | code |

### Per-user caps in our code

32 running turns, 50 queued messages per chat, 20 messages a minute,
60 new machines an hour, 10 new projects an hour, 8 threads started per Super
agent turn, 600 Super agent wakes a day, 8 live agents per task tree, 16 open
tabs. All of these are soft, and listed in [Limits](limits.md).

### Current usage (production, read-only, 2026-11-28)

| Measure | Value |
|---|---|
| Accounts | 10 (all created in the last 30 days) |
| Active in the last 30 days | 2; power users (active on 10 or more of 30 days): **1** |
| Turns | 4,666 in 30 days; **155 a day** for the power user, 270-500 a day on busy days |
| Turn length | median 0.7 min, 90th percentile 6.8 min |
| Running at once (peak per day) | 3-10, mostly 5-7 |
| Turn-hours | 252 in 30 days, 191 of them in Durable Objects |
| Turn mix | 82% Claude Code (Claude plan), plus Codex, Grok and API keys |
| Chats in 30 days | 151 top-level chats, 222 helpers (177 writers, each with its own machine fork) |
| Chats holding a machine | 94 |
| Tokens (30 days, on the users' plans) | about 2.9 billion input tokens, mostly cache reads |

All of this is one heavy power user: the founder, who builds ytimesy with
ytimesy. Per-user numbers below come from that one user (n = 1).

## 3. Capacity: what breaks first, in order

Assumptions: a "power user" works like today's one for the turn-driven
platforms (Cloudflare, database, boxes). For Freestyle we use the
[Limits](limits.md) typical user (8 kept machines, 2 running for 4 hours a
day), because the measured user keeps far more (about 1.7 TB on their own).
At the busiest hour, half of the users are active with about 2 turns running
each.

| Power users | What breaks, in order (today's defaults) | What happens to the user | Fix |
|---|---|---|---|
| **2-4** (heavy) | Freestyle disk (3,125 GB) at about 2 heavy users. The Durable Object spend cap at about 4, if it is about $10: every heavy user adds about 300k GB-s a month, or about $3.75. | New machines wait or are refused; then no new turns start until the cap is raised | Raise the spend cap and add billing alerts; keep fewer, smaller disks |
| **10** | Disk at 82% (typical users), over 100% (heavy users) | as above | Cost-down disks (24 GiB per user), or Pro at $500 |
| **30** | 40 running machines at the busy hour; 200 kept (240 needed); box fleet full (36), so turns go back to Durable Objects | "Starting machine..." waits; higher Cloudflare cost | Pro, or the cost-down design (stays on Hobby up to 100); more boxes |
| **100** | Database path: 5 Hyperdrive connections and Micro compute (60 connections) against about 30M queries a day (estimate); Durable Object requests pass the included 1M (cost only) | slow pages, connection timeouts ("the message was kept; try again") | Raise the Hyperdrive limit; Supabase Medium compute (+$50) |
| **300** | Platform turn limit of 256 at the busy hour; Freestyle Pro disk is too small for today's defaults (76,800 GiB needed); cost-down needs Pro (600 kept machines); one Codex proxy IP carries all Codex traffic | turns queue; "waiting for a slot" | Raise `YTIMESY_FLEET_TURN_CONCURRENCY`; a second egress path |
| **1,000** | Freestyle Pro running limit (400) with today's defaults (1,000 needed); Supabase needs a large compute size; the box fleet needs about 125 boxes at the busy hour (an AWS quota check); PostHog becomes a paid tier | | Enterprise Freestyle, or cost-down; autoscaling spot boxes |

Capacity today: about **2-3 heavy users or 10-12 typical power users** on the
current plans and settings, and up to **40 threads with a running machine at
once**. The cost-down design moves the first wall to about **100 users**
(Freestyle 200 kept machines on Hobby).

## 4. Cost model

### 4.1 Assumptions

| Item | Today's defaults | Cost-down design | Cost-down plus |
|---|---|---|---|
| Machine size | Large, $0.368 an hour | Small, $0.132 an hour | 1 vCPU / 2 GiB, $0.066 an hour |
| Machine hours per user per month | 240 (2 machines for 4 hours a day; the measured user runs about 480) | 48: a machine only while a tool runs (40), plus one writer for 20% of that (8) | 36 |
| Kept disk per user | 256 GiB (8 × 32) | 24 GiB (2 × 12) | 24 GiB |
| Durable Object GB-s per user per month | 300k (measured, n = 1) | 90k: every turn on boxes, the object only coordinates (estimate, -70%) | 45k |
| Worker CPU per user per month | 39M ms (measured) | same | half |
| Postgres egress per user per month | 15 GB (measured 0.4-1 GB a day) | 7.5 GB | 5 GB |
| AWS boxes | 2-6 on-demand plus 2 runner boxes plus the proxy | about 1 box per 8 users at the busy hour, 60% on average, spot (-60%) | same |
| Fixed overhead | Workers Paid $5, Supabase Pro $25, proxy plus IPv4 plus logs about $27 | same | same |

Freestyle is billed as usage minus about $18 of monthly allowances, never
below the plan fee. Supabase compute steps: Micro (included) up to 10 users,
Small +$5, Medium +$50 at 100, Large +$100 at 300, a larger size about +$400
at 1,000 (estimate). PostHog is assumed free under 1M events a month (about
5,000 per user). Email is assumed free.

### 4.2 Monthly cost by user count (list prices, before credits)

| Power users | Today's defaults | Cost-down | Cost-down plus |
|---|---|---|---|
| 1 | $223 | $121 | $121 |
| 10 | $1,205 | $148 | $129 |
| 30 | $3,452 | $364 | $217 |
| **100** | **$11,292** | **$1,221** | **$706** |
| 300 | $33,582 | $3,643 | $2,099 |
| 1,000 | $111,587 | $12,170 | $7,025 |
| Each extra user | ~$110 | ~$12 | ~$7 |

By platform at 100 and 1,000 users:

| Platform | Today, 100 | Cost-down, 100 | Plus, 100 | Today, 1,000 | Cost-down, 1,000 | Plus, 1,000 |
|---|---|---|---|---|---|---|
| Freestyle | $10,413 (Pro) | $767 (Hobby) | $370 (Hobby) | $104,315 (Enterprise) | $7,836 (Pro) | $3,869 (Pro) |
| Cloudflare | $504 | $242 | $147 | $5,067 | $2,442 | $1,490 |
| Supabase | $199 | $132 | $109 | $1,877 | $1,202 | $977 |
| AWS | $175 (fleet capped at 6) | $80 | $80 | $175 (capped; the rest runs on Cloudflare) | $537 | $537 |
| PostHog | $0 | $0 | $0 | $153 | $153 | $153 |

How sure the numbers are: Freestyle ±50% (the machine hours per user are
assumed). Cloudflare ±50% (one user, partly incident days). Supabase egress
within 2× either way. AWS ±30%. The "plus" column depends on two changes
that are not built yet.

### 4.3 Where the curves bend

- **Freestyle**: steps at plan limits. Hobby ($50) runs out at about 12
  typical users with today's defaults (disk). Pro ($500) runs out at about
  240 (disk). After that, Enterprise is a negotiated price. Cost-down stays on
  Hobby up to 100 users (200 kept machines, exactly the limit), then Pro to
  more than 1,000. Between steps it is linear: per machine-hour and per GiB
  kept.
- **Cloudflare**: flat at $5 until the 400k GB-s are used, which takes about
  one heavy user. After that it is linear per GB-s ($12.50 per million), plus
  CPU time ($0.02 per million ms) and requests. The spend cap is a hard wall
  that must be raised in step with users.
- **Supabase**: steps at compute sizes (about 30, 100, 300 users) and at
  250 GB of egress (about 17-33 users), then $0.09 a GB.
- **AWS**: flat ($100-175) until the fleet has to grow past 2 boxes at about
  16 users. With today's limit of 6 boxes, turns beyond 36 at once spill to
  Cloudflare, so the cost moves to Cloudflare instead of AWS.

### 4.4 Biggest levers at 100 users, ranked

| # | Lever | Saves per month | Effort |
|---|---|---|---|
| 1 | Default machine Small instead of Large (users choose Large when they need it) | ~$5,660 | 1-3 days: project snapshots must be built small, because a copy cannot shrink |
| 2 | A machine only while a tool runs (240 → 48 hours per user) | ~$2,530 | 1-2 weeks |
| 3 | Fewer, smaller kept disks (8 × 32 → 2 × 12 GiB): one machine per project, delete on archive | ~$1,460 | 1-2 weeks, with lever 2 |
| 4 | 1 vCPU / 2 GiB where that is enough, 36 hours | ~$400 | days |
| 5 | Every turn (Claude Code too) on boxes, so Durable Objects only coordinate | ~$260-320 | 3-5 days (built behind flags) |
| 6 | Delete the leftover benchmark disks in AWS | $356 now, at any user count (paid from credits) | 30 minutes, with your go |
| 7 | Read less from Postgres (Supabase egress) | ~$55-110 | days |
| 8 | Halve Worker CPU (smaller pages, fewer reads) | ~$40 | days |
| 9 | Spot instances for boxes | ~$50-80 | 1 day |

Levers 1-3 are 90% of the saving. Staying on Hobby rather than Pro saves $450
only while usage stays under $500.

### 4.5 What stays flat

Workers Paid $5, Supabase Pro $25, the Codex proxy (about $7), the Freestyle
Hobby fee ($50, sponsored until 2027-03-15), GitHub ($0), Alchemy ($0), R2
(about 12 GB, which is close to free), email and PostHog under their free
tiers, the 2 minimum turn boxes and the 2 Claude runner boxes (about $80).

### 4.6 Paid by the users, not us

All model inference: ChatGPT (Codex), Claude and Grok plans, and API keys.
The one power user used about 2.9 billion input tokens in 30 days. At API
prices that would be far more than everything above, which is why "bring your
own plan" matters. The Super agent's wakes also run on the user's own plan.
Our only model costs are small helper calls (memory, embeddings), which were
not measured.

### 4.7 Reconciling with today's real spend (November 2026)

| Platform | Measured usage | Monthly at list price | Cash today |
|---|---|---|---|
| Cloudflare | 592k GB-s, 370k DO requests, 2.1M Worker requests, ~30M CPU ms (Nov 1-27) | ~$8 ($5 plan + ~$3 duration) | ~$8 |
| Freestyle | 54 machines, 1,728 GiB disk, 3 running; our compute ledger shows about $160 of compute in November so far | ~$285 usage (compute ~$177, disk ~$108) | $0 (Hobby fee sponsored; promotional credits until 2027-09-15) |
| AWS | 2 turn boxes, 2 runner boxes, 1 proxy, ~4,450 GiB of disk (4,200 of it from benchmarks), 408 GiB of snapshots | ~$460 (~$107 product, ~$356 leftover benchmarks) | probably $0 on credits (billing is not readable with our key) |
| Supabase | 696 MB database, 60-connection compute | $25 (plan assumed) | ~$25 |
| R2, email, PostHog | ~12 GB in R2 | ~$0 | ~$0 |
| **Total** | | **~$780** | **~$33** |

The model's 1-user row ($223) is lower than today's real ~$780 for two
reasons. The benchmark leftovers ($356) are not users. And the one real user
is about 3 times heavier on Freestyle than the typical-user assumption
(~$285 against ~$86).

**Runway.** Credits hide most of the cost until 2027. Freestyle promotional
credits end 2027-09-15 and the Hobby fee sponsorship ends 2027-03-15. The AWS
credit balance is not visible to us. At 100 users with today's defaults,
Freestyle usage alone (~$10,400 a month) would use up a $10,000 credit balance
in about a month. With the cost-down design it lasts about 13 months.

## 5. Risks and single points of failure

| Risk | What it means in plain words | Today |
|---|---|---|
| **One Codex egress proxy** | All ChatGPT (Codex) traffic leaves through one tiny AWS machine with one IP address in one region. If it stops, or OpenAI throttles that address, Codex chats depend on the Cloudflare VPC fallback. | Fallback exists; no second proxy |
| **Durable Object spend cap** | A hard dollar cap on Cloudflare duration. When it is reached, chats cannot start turns until the month resets or someone raises the cap. One heavy user already uses more than the included amount. | Must be raised as users grow |
| **Freestyle Hobby limits (disk, 40 running, 200 kept)** | Beyond them, new machines wait for up to 15 minutes, then are refused. Disk is 55% used by essentially one user. | Retention job and a guard at 95% |
| **Postgres path** | One database for everything, reached through 5 Hyperdrive connections on the smallest compute size. If it is slow or down, the whole product is. | Backups to R2; retries |
| **6-box limit** | No outage: overflow runs on Cloudflare at higher cost, and only for users enabled for boxes. | |
| **Hand-made machines** | The Codex proxy and the Claude runner boxes are not in Alchemy, so rebuilding them is manual. | Documented steps |
| **Credit cliff** | Freestyle and AWS cash costs start when credits end (2027-03 for the Hobby fee, 2027-09 for Freestyle usage). | |
| **One region** | Everything runs in us-east (AWS us-east-1/2, Supabase, Freestyle). | |

### Top 5 things to do next, in order

| # | Do | Effort | Cost impact |
|---|---|---|---|
| 1 | Check the Durable Object spend cap against expected use, and add billing alerts at 50/70/90% (Cloudflare, Freestyle disk) | 1 hour | Prevents an outage at about 4 heavy users; allows about $4 per heavy user a month |
| 2 | Delete the stopped benchmark machines' disks and snapshots in AWS (needs your go; destructive) | 30 minutes | -$356 a month of credits |
| 3 | Make Small the default machine size, and build project snapshots small | 1-3 days | -~$57 per power user a month (-$5,660 at 100) |
| 4 | Build the cost-down machine lifecycle: a machine only during tool calls, one per project, 12 GiB disks, per-user caps (3 running, 2 kept) | 1-2 weeks | -~$40 per power user a month; stays on Hobby up to 100 users |
| 5 | Run every turn on autoscaling spot boxes (Claude Code too), raise the 6-box limit, raise the Hyperdrive connection limit, plan Supabase Medium at about 30 users, and add a second Codex egress path | 3-5 days | -~$3 per user a month on Cloudflare; removes two single points |

With 3 and 4 done, 100 users costs about $1,220 a month. Adding the "plus"
levers (1 vCPU machines where enough, all turns on boxes, fewer reads) brings
it to about $700, under the $1,000 budget.

## 6. Glossary

| Name | One line |
|---|---|
| Cloudflare Workers | Small programs on Cloudflare's network that serve our pages and API, billed per request and CPU time. |
| Durable Object (DO) | A Cloudflare mini-server with its own storage, one per chat (and others), billed for every second it is awake (GB-s). |
| GB-s | Gigabyte-seconds: memory multiplied by time awake; how Durable Object time is billed. |
| Hyperdrive | Cloudflare's connection pooler between our Workers and Postgres. |
| R2 | Cloudflare's file storage (like S3), used for checkpoints and backups. |
| Supabase | Hosted Postgres database, our source of truth. |
| Postgres | The database itself. |
| AWS (EC2) | Amazon's cloud; we rent small Linux machines there (turn boxes, the Codex proxy, Claude runners). |
| Turn box | An AWS machine that runs a chat's model loop so the Durable Object can sleep. |
| Codex egress proxy | The AWS machine that sends ChatGPT (Codex) requests from a fixed address. |
| Claude Agent runner | The Claude Code program (Claude Agent SDK) running a chat on the user's Claude plan. |
| Freestyle | The company whose VMs are our users' workspaces (code, terminal, desktop). |
| VM | Virtual machine: a computer rented by the hour. |
| Spot instance | A spare AWS machine at about 60-70% off that AWS can take back. |
| GitHub App | Our integration that reads repositories and opens pull requests. |
| PostHog | Product analytics (which features people use). |
| Alchemy | The tool that describes our Cloudflare and AWS setup as code (`infra/alchemy`). |
| Codex / ChatGPT, Claude, Grok | AI models the user connects with their own plan. |
| API key | A user's own pay-as-you-go key for a model provider. |
| Super agent (Y²) | The project agent that starts and watches threads. |
| Writer | A helper agent that edits code on its own forked machine. |

## What could not be measured

- AWS billing: our key cannot read Cost Explorer, so AWS numbers are list
  prices times measured resources, and the credit balance is unknown.
- Supabase plan and usage: the management API refused our token. Pro on Micro
  compute is inferred.
- Freestyle invoices: the API has no billing endpoint. The figures come from
  the machine list and our own ledger.
- The actual Durable Object spend cap value and the real throttling point of
  the Codex proxy's IP address.
- How a "typical" power user differs from the one measured user; peak
  concurrency across many users.
- PostHog event volume and email volume.
- Per-turn Durable Object savings once every turn runs on boxes (the -70% is
  an estimate).

Sources: production Postgres (read-only counts), Cloudflare GraphQL
analytics and the Hyperdrive config API, the Freestyle `GET /v5/vms` and
`/v5/snapshots` endpoints, AWS EC2 and Auto Scaling describe calls (read-only),
and list prices from Cloudflare, Freestyle, Supabase and AWS as of 2026-11.
