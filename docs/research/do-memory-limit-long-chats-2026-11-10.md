# Long chats exhaust a Durable Object's memory (2026-11-10)

**Symptom.** A long chat's turn fails with "The worker disconnected. Inspect the
workspace before continuing" or "Claude Agent stopped ... (code 143)", and steps
show "interrupted by a server restart" notices. Workers logs say
`Durable Object's isolate exceeded its memory limit and was reset`
(`platformRestart: true`), twice in a row, then `Chat step kept failing; turn
abandoned.` In the 4 hours to 03:05 UTC: 72 memory resets (02:10-02:59, at least
7 turns) against 13 "code was updated" resets (only 23:23, 00:40, 01:56). It is
mostly not deployment.

## What the data shows (production, read-only)

- `agent_session.items` of the two largest chats: 1.24 MB and 1.18 MB compressed
  (about 3 MB as text), 1,279 and 1,239 items. For the chat checked, 555 tool
  calls are 2.1 MB of the text (about 3.8 KB each, the largest about 18 KB:
  there is a per-item output cap already), agent messages 0.3 MB, user messages
  0.1 MB, reasoning 0.07 MB.
- **Every `api_turn` row carries a full copy of the session's items**:
  `api_turn.items` is 1,178,306 bytes for the newest turn, the same as
  `agent_session.items` (1,178,306); the previous turns are 1,176,613 and
  1,173,699. So a step's start (`select messages,items from api_turn where id=$1
  and lease_id...`, logged as `db.large_result` about 2.2 MB) loads the whole
  history, and every new turn stores another copy of it. Cost per step and per
  turn grows with the length of the chat, not with the work being done.
- The conversation delivery claim returns the "latest page" of the chat
  (`TRANSCRIPT_PAGE_TURNS`). It logged about 1.1 MB per call, many times a second
  during heavy tool use, because the current turn alone (hundreds of tool calls)
  is that large.
- The edge executor bundle is 21.5 MB, of which 10 MB is the `typescript`
  package. It is imported lazily (`edit-diagnostics.ts`), so it should not
  load at startup; it loads on the first edit of a .ts/.js file by the harness's
  own edit tools, not for Claude Code turns (Claude edits on the VM).

## Not established

- Where the 128 MB actually goes. I did not profile. A 3 MB text parsed into
  objects, several copies per step (turn row, session record, delivery
  snapshot, progress snapshots serialized again on every publish), on top of
  the bundle, is the leading explanation, not a measurement.
- Whether any Workers memory figure (128 MB per isolate) matches this
  deployment; it is from memory, not checked against Cloudflare's docs.

## Remaining execution-history work

1. **Step cost proportional to the active turn.** Load only the active turn's
   items plus a cursor; append to the history in SQL (`items = items || $new`)
   instead of rewriting a whole copy; older turns are read only by paging.
   Stop storing a full copy of the session's items in each `api_turn` row.
2. **Bound what one turn keeps.** Past a size (items or bytes) older tool
   outputs in the active turn are trimmed to a preview, with the full output
   kept outside the row if it should stay viewable.
3. **Deliver deltas, not pages.** Send changed items per revision, not the whole
   latest page each time.
4. **Measure first.** Reproduce with a large synthetic chat in workerd, log
   `performance` heap use per step, then change one thing at a time.

Steps 1-3 touch `api-turn.ts` (3,000+ lines, 18 tests already failing before any
change), the delivery protocol and the transcript paging: large changes, to be
done as a focused project, not alongside other work. The earlier estimate of
roughly 1,000 items was not a measured safe limit; item sizes and concurrent
allocations matter, so it must not be treated as an admission guarantee.

## Follow-up implementation (2026-11-10, not deployed)

Display/delivery pages now have item-count and serialized-byte bounds, including
inside a single oversized turn. Older content is still pageable. Context usage
is fetched independently so paging out a user message does not erase it.
This bounds normal snapshot delivery, not cumulative execution history; one
individually oversized item is still allowed through so it remains readable.

Claude checkpoint saving probes transcript size on its execution host before
reading it into the Worker. The 249 MiB regression case is rejected before
transfer, and a prior valid checkpoint for the same session is retained. The
20 MiB checkpoint limit itself has not changed. Full `api_turn` history loading,
full snapshots used by execution checkpoints, and delta delivery remain
separate work. No heap profiling or unlimited-demand reliability result is
claimed. See `docs/claude-job-lifecycle-hardening.md` for checks and rollout.

## Execution-history implementation (2026-11-10, not deployed, not live-verified)

- **Sizes per step.** `turn.step_sizes` (`src/server/edge/turn-step-sizes.ts`)
  logs message/item counts, items after the last user message, serialized bytes
  when the history came from Postgres, and `heapUsed` where the runtime reports
  it. Use it to confirm where memory goes before further changes.
- **No full copy per turn.** A durable-object turn row now stores
  `items = {"from": <id of its user message>}`; `agent_session.items` is the
  only history. The step loader reads the chat's items for such rows and the
  array for old rows (both shapes read for one deploy; old rows keep their
  own shape until they finish). Drop the old shape later.
- **Append in SQL.** Writes send only the turn's items; SQL keeps the chat's
  items before `from` and appends them (`turn-items-storage.ts`). If an earlier
  item changed in memory, the full list is sent instead.
- **Bounded active turn.** At each checkpoint, past 1,000,000 characters of
  tool output in the turn, older outputs become 2,000-character previews (the
  newest 20 stay whole). This trims display items, not the model's messages;
  the trimmed full output is not kept elsewhere.
- Still open: delta delivery (step 3), whether a running turn still sends its
  whole active slice per write (yes), and measured heap results. Unit tests
  cover the planner and the bound; the SQL was not run against Postgres.
