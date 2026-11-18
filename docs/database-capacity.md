# Database connection lifecycle and capacity

## Implemented controls

- Each web or worker process owns one `pg.Pool`, shared by application queries, authentication, and pg-boss through its `db.executeSql` adapter. There is no connection per user, chat, or job.
- `DATABASE_POOL_MAX` defaults to 2 and accepts integers from 1 to 20. This is a per-process limit, not a deployment-wide limit. Change it only with a measured connection budget.
- Pool acquisition times out after 10 seconds; statements after 20 seconds; idle transactions after 30 seconds. Idle connections are released after 30 seconds and connections rotate after five minutes. Rotation does not interrupt a checked-out client.
- Application pools and queue startup promises survive development module reloads. Concurrent callers await complete queue initialization. Failed startup stops the partially initialized queue and clears the failed promise before retry.
- Web queue producers do not run maintenance, scheduling, or schema migrations. Start the separately deployed worker before accepting job submissions on a fresh database or after a pg-boss version upgrade. The worker owns these duties. Application schema migrations remain separately managed under `supabase/migrations`.
- LISTEN/NOTIFY is disabled. Queue workers poll; they do not create an extra pinned listener connection. Worker shutdown stops the queue before closing the shared pool.
- Idle-client and queue background errors are logged without SQL, payloads, or credentials.

## Deployment budget

For the current session-pooler connection mode:

`web replicas × web pool max + worker replicas × worker pool max + other clients + rollout overlap + reserved headroom <= available pooler client slots`

For example, three web processes and one worker at 2 connections each consume at most 8 slots. On a 15-slot pooler that leaves 7 for rollout overlap, operations, and other clients. This is arithmetic, not a throughput recommendation. Enforce replica caps in the chosen hosting platform; application code cannot enforce a global budget across arbitrary deployments.

Keep `DATABASE_URL` configured with verified TLS. No endpoint or Supabase capacity was silently changed by this fix. Session pooling is the existing deployment choice. For a future serverless deployment, validate transaction pooling against the entire workload before switching: explicit transactions must stay on their checked-out client, session state must not be assumed, and pg-boss migration/maintenance behavior must be tested. Do not merely rewrite the port or assume the same connection limit applies.

## Gate for 10,000 users

10,000 registered accounts, 10,000 simultaneous viewers, and 10,000 running agents are different workloads. None is certified by this connection fix. In particular, 10,000 queue-initialization calls in a unit test prove singleton behavior, not production user capacity.

Before claiming that capacity:

1. Define peak active sessions, running VMs, jobs per second, request rate, and latency/error targets. Include reconnect bursts and authentication refreshes.
2. Load-test authenticated project/session reads, event streams, job submission/claiming, and token refresh using isolated test tenants and infrastructure. Do not run a large test against live user VMs or billable inference without an explicit budget.
3. Measure `pg.Pool.totalCount`, `idleCount`, and `waitingCount`; query latency/timeouts; database CPU and locks; queue backlog/age; and HTTP errors. A small pool can still saturate. Connection timeouts bound waiting duration, not the number of incoming requests: production admission limits/rate limiting are still required.
4. Budget all replicas and rolling deployments. Size the database/pooler and set hosting replica caps from measurements, leaving operational headroom. The observed 15-slot configuration is not a 10,000-user capacity promise.
5. Inspect polling/read amplification and long transactions. Credential refresh currently holds row locks while contacting the provider; include this contention in testing. Keep inference and VM execution outside database transactions.
6. Exercise rolling restarts, repeated development reloads, failed queue startup, database outages, and recovery. Separately validate VM quotas, stream fan-out, worker concurrency, and cost ceilings.

Hosting limits, fleet-wide admission control, production dashboards, a 10,000-user workload test, and any required infrastructure upgrades remain deployment work, not completed features.

## Sources

- [node-postgres pool sizing](https://node-postgres.com/guides/pool-sizing): budget pools across all service instances and leave headroom.
- [Supabase connection methods](https://supabase.com/docs/guides/database/connecting-to-postgres): choose connection mode for the deployment environment.
- [pg-boss documentation](https://pgboss.io/): the pinned 12.31.0 package provides the custom database adapter and producer/worker configuration used here.

## Connection failures and the send's retry policy

Every request (Worker or Durable Object) has its own `pg` pool of at most 2
connections (`src/server/adapters/database-scope.ts`), each caller waiting at
most 10 s for one.

- **Log event.** Each connection failure logs one warning,
  `Request database connection failed.`, with `stage` (`connect`, `query`,
  `send-transaction`, or `client-error` for a socket that died while pooled),
  `code`, `message` (the error message only, cut to 200 characters; never SQL,
  parameters or user content), `attempt`, and the pool's `total`, `idle` and
  `waiting` counts. `total=2, idle=0, waiting>0` means the request's own
  queries were holding both connections.
- **Retry.** A failure to get a connection (`isConnectFailure`: "timeout
  exceeded when trying to connect", "Connection terminated due to connection
  timeout", `ETIMEDOUT` on connect, 57P03, 53300) happens before any
  statement ran, so the pool's promise-form `connect()`/`query()` repeat it
  twice, after 250 ms and 750 ms. `isDroppedConnection` (turn writes) is
  unchanged.
- **The send's transaction** (`enqueueApiTurn`) repeats on a connect failure
  before `begin`; after `begin` only when the send has an idempotency key (the
  gate statement then finds the turn that did land and queues nothing). A
  keyless send that failed after `begin` is never repeated.
- **Person's view.** After the last repeat the composer shows "Couldn't send
  that: the database connection timed out. Your message was kept; try again."
  (`publicFailureMessage`) and takes the typed message back.

## Egress budget

Supabase Pro includes 250 GB/month of egress. Egress here is what query
results carry from Postgres to the Worker. Goal: 100 active users well inside
it.

### Measured (production, `pg_stat_statements` since 2026-10-27, one active user, about 3 weeks)

| Read | Calls | Rows | Rows/call |
| --- | --- | --- | --- |
| Usage windows (`readWindows`, three statement variants: user usage read, admission check, reserve) | ~11k | 3.4M + 1.1M + 1.06M | 750 / 287 / 424 |
| Recovery points (`listConversationRecoveryPoints`) | ~14k | ~0.8M | ~58 |
| Background command items (`backgroundCommandItemsForOwner`) | ~32k | ~0.45M | ~14 |

Row counts are measured. **Bytes are estimated**, not measured:
`pg_stat_statements` has no byte counts. The usage reads were estimated at
~0.7 GB for the three weeks (about 125 bytes per row, each repeating the
policy/window columns).

### What changed

- **Usage reads** now return one row: Postgres sums the week's reservations
  per window (`usageWindowStateFromSums`, same arithmetic as
  `usageWindowState`). A differential PGlite test
  (`infrastructure-usage.differential.test.ts`) runs the old query and JS
  against the new read on 150 randomized reservation sets (open holds, settled
  in and out of the window, carried, waived, window resets, boundary
  timestamps) and asserts identical results. The `usage-admission.ts` reads go
  through the same function; it has no statement of its own that returns
  reservation rows.
- **Background command items** for the agents list (polled every few seconds)
  are projected in the database to the four fields the list reads (id, label,
  start, exit), not the whole item with the tool's input and output.
  Watcher and activity callers still read whole items.
- **Recovery points** are unchanged: each row is two small values (~50-100
  bytes), the limit of 100 is what the UI needs to show a recovery row under
  every message, and no index problem is visible from the code. No migration.
- **Visibility.** Each isolate logs one `db.egress_summary` line per 10
  minutes (top 5 query tags by approximate bytes, plus totals), from the
  running totals the byte accounting already estimates. Use it to replace the
  estimates below with measurements.

### Per-user estimate and 100-user projection

Estimated, one active user, scaled from 3 weeks to 30 days (x1.43):

| | Before | After |
| --- | --- | --- |
| Usage reads | ~1.0 GB/month (from the ~0.7 GB estimate) | ~0.006 GB/month (~11k calls x ~350 bytes, one row) |
| Background items (agents list) | unmeasured; 14 rows x item size. At 1-10 KB per item (assumption), 0.6-6 GB | ~0.06 GB (14 rows x ~100 bytes x 32k calls) |
| Recovery points | ~0.07 GB | unchanged |

100 users, if they behave like this one (they may not: this user's call rate
is the only data): usage reads ~100 GB before, ~0.6 GB after. The background
items line is the least certain; the egress summary will show it. The other
reads not listed here (transcript pages, sidebar, polling endpoints) are not
in these numbers; they need the `db.egress_summary` data to be added. Do not
read this table as a forecast of the whole bill.

### Round 2: transcripts (`agent_session.items` and item rows)

Target (owner decision): 100 power users (about 300 turns/day, long chats)
under Supabase Pro's 250 GB/month with margin, so **<= 1 GB per power user per
month (~30 MB/day)** from query results.

**Measured** on production (`pg_stat_statements` since 2026-10-27, one power
user, ~3 weeks; bytes from `pg_column_size`):

- `agent_session.items` averages 278 KB per chat, up to 4.5 MB; 157 chats.
- `dynamicToolCall` items average 2.1 KB; `canvas` items 24 KB (the `html`).

| Shape | Calls (3 wk) | Rows/call | Carries |
| --- | --- | --- | --- |
| A. `select <SESSION_COLUMNS with items> from agent_session where ...` | 18,872 | 1 | the whole transcript |
| A'. `update agent_session ... returning <SESSION_COLUMNS>` | not in the measured list | 1 | the whole transcript (found in code) |
| B1. `agent_session_item` rows with `item->'background'` | 32.8k | 14.5 | full tool items (input and output) |
| B2. `agentSessionItemsOfKindsForOwner` (kind of every open chat) | 836 | 151 | whole items of that kind |
| C. `with recursive descendants` | 14k | 3.5 (~756 B/row) | metadata only (confirmed: width matches a row without `items`; code selects `SESSION_COLUMNS` minus `items`) |
| D. `with s as (...)` page reads | 15k | 1 (+ page) | metadata + one page of item rows (last 30 turns, `jsonb_agg`), never the `items` column |

The `$3 as items` / `null as items` variants (62k + 5k calls) were already fine.

#### Callers fixed

| Caller (where) | Per | Before | After |
| --- | --- | --- | --- |
| `harness-workspace-session.ts` send for Codex/Claude Code (`agentSessionForOwner` at `send:chat`) | send | whole transcript | row only; transcript read only when the runtime switches (handoff) |
| `readApiWorkspaceSession`, `readSubscriptionSessionState` fallbacks (replayed send, connect, no read passed) | view | whole transcript | the latest page (30 turns), same as the chat opens with; `hasOlderItems` is set |
| `push-approval.ts` `cardRequest` (answer/preview/push a card) | card action | whole transcript | row + the one card by `item_id` (`sessionItemForOwner`) |
| `pasted-text.fn.ts` (open a pasted-text chip) | click | whole transcript | row + attachments of user messages (`userMessageAttachmentsForOwner`) |
| `side-chat.ts` `sideChatForParent` (every side-chat read/send, twice per send) | read | whole transcript of the side chat | row only |
| `agentSessionById` | - | whole transcript | row only (no caller read `items`) |
| `update ... returning` of `saveSessionWorkingBranch`, `saveAgentWorkingBranch`, `selectAgentSessionHarness`, `saveAgentSessionProviderRef`, `saveAgentTaskState`, `saveSessionBranchSelection` | write | whole transcript back | row with `items` null (callers already treat null as "not held": `heldTranscript`, `sessionHoldsUserMessage`); `reusableEmptyChat` returns `[]` (it is empty by its WHERE) |
| `project-workspace.ts` legacy-conversation check | project open | all user messages | `sessionHoldsUserMessage` (one boolean) |
| `descendantTokenUsageItemsForOwner` (a subagent's budget check, every model step) | step | every descendant's user messages | `kind, id, apiUsage` only |
| `conversation-recovery.ts` fork code | fork | user messages | `kind, id` only |
| `agent-peer-messaging.ts`, `subagentTree` (adapter), `agent-task-activity.ts` spend items, `subagent-tools` `itemsOfKinds` | steer / step / panel poll | user messages with attachments and recalled memory | text, timing, usage kept; `attachments`, `memory`, `contextUsage` dropped in SQL |
| `side-chat.ts` parent snapshot | send | items with tool input/output | no `input`/`output`/bulk keys |
| `backgroundCommandItemsForOwner` default (watcher) and `agent-task-activity.ts` panel poll | tick / poll | full item with `output` | no `output`; panel poll uses the 4-field `records` projection |

Per request, the transcript is read at most once on a send: the send used to
read it at `send:chat` and again through `commitChatBranchForSubmission`'s
`returning`, and passed that copy along. Now neither reads it.

#### Left as they are (not hot paths)

- `wholeTranscript` in `api-workspace-session.ts`: plan approval (`approvesPlan`),
  and a send with no stored previous-turn history (first turn after a model or
  connection change). Rare; logs `session.full_read` with the caller when it
  happens on a long chat.
- `postPushResultNotices` (`push-approval.ts`): writes notices back with a
  compare-and-swap on the whole transcript; only when an answered push card
  has an unannounced result.
- `claimInitialSetupChat` existing-row select, `insertAgentSession`
  (new, empty chats), `saveAgentSessionItems` (local import).
- `descendantAgentSessions` and `agentSessionForOwner` from `scripts/` and
  `benchmarks/` (offline evaluation and export).

**Whole-transcript reads left on hot paths: zero.** The regression test
(`agent-session-egress.test.ts`) fails if any metadata/hot function selects the
bare `SESSION_COLUMNS`, or if a hot read returns a non-null `items` column in
PGlite.

#### Visibility

Statements in `agent-sessions.ts` start with `/* functionName */`; the byte
accounting's tag (`db.large_result`, `db.egress_summary` top 5) is now
`functionName hash first-words`. pg_stat_statements ignores comments in its
query id, so statistics do not split. `withQueryLabel(label, sql)` does the
same for any other statement.

Measure with `scripts/measure-egress-shapes.ts` (read-only: calls and rows from
`pg_stat_statements`, `pg_column_size` per table and per item kind, estimated
bytes = calls x rows x sampled size). The owner runs it.

#### Before/after, one power user per month (ESTIMATED unless noted)

Scaled x1.43 from 3 weeks to 30 days. `pg_column_size` is the stored,
possibly compressed size; text sent to the Worker is usually larger, so
"before" is a lower bound.

| Shape | Before | After |
| --- | --- | --- |
| A (18,872 calls x 278 KB, measured inputs) | ~7.5 GB | ~0.03 GB (metadata ~1 KB/row) |
| B1 (476k rows x 2.1 KB measured average item; ~1.4 GB) | ~1.4 GB | agents list ~0.07 GB; watcher without `output` (unmeasured, smaller) |
| B2 (126k rows; size per row unmeasured: 2.1 KB if tool-sized ~0.4 GB, up to ~3 GB if canvas-heavy) | 0.4-3 GB | text + usage only, ~0.1 GB (user message without files/memory; unmeasured) |
| C | ~0.04 GB (14k x 3.5 x 756 B, measured width) | unchanged |
| **Subtotal** | **~9-12 GB** | **~0.3 GB** |

**100 power users:** before ~900-1,200 GB/month, 4-5x the 250 GB budget; after
this round ~30 GB for these shapes (estimate).

### Page reads (chat open / refresh / send / snapshot)

**Measured** (production, one power user, ~3 weeks, `pg_stat_statements` +
`pg_column_size`): `agentSessionPageForOwner`, 1 row per call, the row carries
the page's items. 15,043 calls averaging 117 KB (6 turns; median 102 KB, max
509 KB) and 7,288 calls averaging 189 KB (30 turns; median 127 KB, max 1.87 MB):
~3.1 GB per 3 weeks, **~4.5 GB/month per power user, ~450 GB/month at 100 power
users (1.8x the 250 GB budget)**. Item sizes (avg bytes): dynamicToolCall
2,110 (20k rows), canvas 23,872, userMessage 882, agentMessage 830, reasoning
568, notice 262.

**Changed (this round):**

- **Payload diet in SQL** (`pageItemSql`, `transcript-page-sql.ts`), used by
  `agentSessionPageForOwner` and the live snapshot/delta reads
  (`LATEST_PAGE_ITEMS_SQL`, `latestPageRowsSinceSql`), so the bytes never
  leave Postgres: a canvas's `html` is not sent (`htmlOmitted`); a tool call's
  plain-text `output`, or the `output` text of a JSON result record, keeps head
  and tail (2 KB total, exit line kept) and its other long input texts are
  cut the same way, with `truncated: true` and `detailSession`. Kept whole:
  messages, reasoning, `run_code`/`agent`/`agent_send` calls (cards parse their
  JSON), and the `content`/`new_string`/`old_string`/`command`/`code`/`diff`
  input fields (the collapsed card counts their lines).
- **Lazy detail:** `sessionItemDetailForOwner` / `getSessionItemDetail` read
  one tool call or canvas whole by id. The tool card's body (rendered only
  when opened, `LazyDetails`) and the Canvas panel call `useWholeItem`
  (`whole-item.ts`), which shares one read per item and state.
- **Smaller first page:** chats open, refresh and answer sends on the last
  `OPEN_PAGE_TURNS` = 10 turns (was 30); older turns load on scroll as before
  (30 per scroll page).
- **Instrumentation:** statement label `agentSessionPageForOwner`,
  `sessionItemDetailForOwner`; one `session.page_read` log line per page read
  with `bytes` (JSON size of the page's items), `items`, `older`.

**Estimated after** (not measured; the share of page bytes that is cut tool
text/canvas is unknown until `session.page_read` runs in production; assumed
35-50% of a page): 6-turn reads ~70 KB, open reads ~60-70 KB (30 -> 10 turns,
then the diet) => ~1.5 GB per 3 weeks, **~2.2 GB/month per power user, ~220 GB
at 100 power users** (inside 250 GB, but with little margin and above the
1 GB/user target). Together with the ~30 GB of the shapes above that is ~250 GB:
**not yet comfortable**. To reach 1 GB/user: fewer full page reads
(serve refocus/reconcile from `itemRowsSinceForOwner` deltas, which exist;
`SNAPSHOT_TURNS` 6 -> 3) once `session.page_read` shows which callers
dominate.

**Not yet in these numbers:** usage windows, polling endpoints, and `agent_session_item`
reads outside the list above. Treat "~30 GB" as the cost of the shapes listed,
not as a forecast of the bill; confirm with `db.egress_summary` (now naming
callers) and the measurement script before relying on it. Natural next
step if D is large: serve polls from `itemRowsSinceForOwner` deltas (as the
helper panel does) instead of re-reading the page.
