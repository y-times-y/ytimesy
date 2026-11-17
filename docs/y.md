# Y and Y²

Status 2026-11-12: built behind a per-project switch (Project settings → Y → "Use Y and Y²", `project.y_enabled`) and the harness variant `y=on` for eval users. Off by default. Not yet run end to end on real VMs.

## Layers

| Layer | One per | Does | Tools |
|---|---|---|---|
| **Y²** | project | Watches every thread and tells the person what is going on: what needs them, what is working, what finished with its pull request. Never works. | `threads`, `thread`, `start_thread`, `message_thread`, `stop_thread`, `ask_user` (`src/domain/y-squared.ts`, `src/server/services/y-squared-tools.ts`) |
| **Y** | thread (chat) | The agent the person talks to. Hands every change to builders, asks readers for code facts, reports in ≤100 words. Never changes, runs or reads code. | `agent`, `agent_send`, `ask_user`, `request_project_secret` (`src/domain/y-agent.ts`) |
| **Builders** | piece of work | Today's builder harness as writer subagents on forks of the thread's VM. Not conversational: brief in, report out. | the full harness |
| **Subagents** | — | Bounded helpers under a builder, as before. | as before |

Why Y does not execute: DeepSeek's Super-agent essay (Nov 1 2026, section 2.1): the router "is designed not to execute tasks itself" so the single node every message reaches is not a bottleneck, and in their ablation a single session told to delegate often did the work itself anyway.

## How work reaches the pull request

1. Y starts a builder (`agent`, role writer) with a self-contained brief.
2. The builder works on its fork; at the end the runtime exports its patch to Y's VM, as for any writer.
3. With Y on, the runtime applies the patch to Y's checkout (`applyWriterPatchToParent`): `git apply --index --check`, then apply. A patch that does not apply cleanly changes nothing; Y is told why and starts a builder to resolve it. No conflict markers are ever committed.
4. Y's turn always commits (an empty commit is skipped) and publishes to the thread's branch and pull request, as a chat does.

## Y²

- Created on the first sidebar listing once the switch is on and the project has a thread (`ensureYSquaredChat`); one per project (partial unique index `agent_session_one_y2`; `chat_role = 'y2'` must be a root chat).
- Listed first in the project's chats, above pinned threads; it cannot be archived from the sidebar.
- Its reads count as read-only, so its turns never wait for a VM or commit.
- Starting, messaging and stopping threads: see Y² write tools.
- **Routes.** Y² runs on Codex, Grok or an API key, never on Claude Code (the Claude subscription): that route runs the `claude` CLI on a VM or runner box and always needs a workspace, which Y² deliberately lacks. The composer's picker leaves the Claude models out for Y² (with the note "Y² runs on Codex, Grok or an API key, not a Claude subscription."); a Y² send on a Claude Code route is refused before any turn is queued ("Y² can't run on a Claude subscription yet. Pick a Codex, Grok or API-key model for this chat.", `sendClaudeCodeTask` and the last gate in `enqueueApiTurn`), and Claude Code is never offered as a failover target for Y² (`planModelFailover`). Claude Code support would need a runner box with Y²'s tools served over the MCP bridge; not built.

## Y² write tools

`start_thread(title, brief)`, `message_thread(id, text)`, `stop_thread(id)` (`src/server/services/y-squared-tools.ts`, schemas in `src/domain/y-squared.ts`). Y² runs threads like a captain; it still never works and has no VM.

- **Start.** A new root chat in the project through the person's own send path (`sendComposerMessage`, `createNew: true`, Y²'s own model); the first line of the message is the title. The result says `Started` (the turn is running) or `Queued … behind the budget/concurrency limit`.
- **Message.** The id must be a root thread of the same project, not Y² and not a subagent (metadata row only: `agentSessionMetadataForOwner`, never the transcript). A running thread queues the message behind its turn; an idle one starts a turn. Same `sendComposerMessage`, so the existing queue applies. Not `queueAgentPeerMessage` (parent→child only, reads transcripts). Messages and briefs are capped at 8,000 characters.
- **Stop.** `stopTurnKeepingQueue`, the Stop button's path, for a running thread.
- **Admission.** Every VM start goes through the usual turn start: per-user turn concurrency (32), usage windows, Freestyle usage and Cloudflare budget admission. There is no new thread cap. `Y_SQUARED_MAX_STARTS_PER_TURN` (8) only bounds a runaway loop in one Y² turn (per tool instance; one instance per step).
- **Idempotency.** Each send is keyed by Y²'s turn id and a hash of its content, so a replayed step does not start or send twice.
- **Cost.** No polling, no new Durable Object request: the tools read one Postgres metadata row per message/stop and none for start. Y² is woken by the crew as before when a started thread finishes or needs the person.
- **Turn rules.** The three tools count as workspace-neutral in `turn-saving.ts` (like `threads`): Y² has no checkout, and a turn that counted them as changing one would fail on "Y² has no workspace". Y² never commits.
- **Gating.** The tools exist only in Y²'s own turn (`ySquared` in `api-turn.ts`).

## Crew status and wakes

Y² does not read thread transcripts. Each Y project has one `YSquaredCrew` Durable Object (`src/server/edge/y-squared-crew.ts`, named by project id, SQLite, binding `Y_SQUARED_CREWS`, migration v5).

- **Rows.** `crew(session_id pk, title, state, waiting_on, pr_url, last_reply ≤300 chars, updated_at)`: one row per thread, rewritten in place; an identical note writes nothing; rows untouched for 30 days are pruned (at most daily). `wake_state` holds `pending`, `last_wake_at`, `wakes_this_hour`, `hour_start` (and the wake target).
- **Push on transitions.** A thread's `ModelConversation.noteTurnStatus` also calls `noteThread` when its turn starts (`working`) and when it settles (`waiting` on the person / `finished` / `failed`), fire and forget under `waitUntil`, errors swallowed. What it waits on, its pull request and last reply come from the transcript copy the chat object already holds (`chatWaitingOn`, `threadHistoryFacts`): no Postgres read. The chat's project, `project.y_enabled` and its Y² id come with the scope `resolveModelConversation` already reads each step (one join, no extra round trip) and are kept in the chat's SQLite (`crew_scope`, written only when they change). A chat of a project without Y, and Y² itself, send nothing (`crewProjectFor`). The switch is refreshed at the next turn start.
- **Debounced wake.** A note that matters (finished, needs the person, failed; never plain progress) sets `pending` and, if none is set, an alarm at `max(now + 45 s, last_wake_at + 45 s)`. The alarm clears `pending` and enqueues exactly one Y² turn through the normal send path (a hidden wake message, shown as a silent wake notice), then records `last_wake_at`. At most 12 wakes per hour per project; the 13th stays pending and fires when the hour window rolls over. A failed enqueue hands the wake back for the next note to re-arm. No alarm exists while the project is idle, and Y²'s own session id never wakes it.
- **Reading.** Y²'s `threads` is one `list()` request, `thread` one single-row request. An empty, never-filled crew is filled once from `listSidebarAgentSessions` metadata (no items), then marked reconciled. Without a binding (local development) the tools read that metadata only. `noteThread` accepts the first deploy's older shapes (`turnStatus`, `pullRequest`, `reply`).

Cost per thread-turn: 2 notes (start, settle) = 2 crew requests, ≤2 row writes (one upsert each; a repeat of the same state writes none) plus ≤1 `wake_state` write when the note matters. A wake adds 1 alarm invocation, ≤3 `wake_state` writes and one normal Y² turn. A Y² overview read is 1 request, 0 writes. The thread's own object adds ≤1 `crew_scope` write when its project settings change.

## Checks

- Unit tests: `src/domain/y-agent.test.ts`, `src/domain/y-squared.test.ts`, `src/server/services/y-tools.test.ts`, `src/server/services/y-squared-tools.test.ts`, `src/server/edge/y-squared-crew-store.test.ts`, `src/server/services/subagent-writer-apply.test.ts` (real git), and Y / Y² turns in `src/server/jobs/api-turn.test.ts`.
- SQL: the migration and `y-mode.ts` queries were run on the development database inside a rolled-back transaction.
- Live behaviour (Opus 5.5, tools simulated): `scripts/y-behaviour-check.ts` (Y, 20/20 checks after one prompt change) and `scripts/y-squared-behaviour-check.ts` (Y², 44/45; the miss was the check's wording).
