# Capy parent observation and harness reference

Verified against first-party public sources on 2026-10-02. This is documented behavior, not a live authenticated Capy run or an inspection of its private scheduler.

## Does the leader stay active while children run?

Capy documents a durable, event-driven parent that can inspect and redirect children. It does **not** document a model continuously thinking or receiving every child step. The parent receives a child's final summary automatically; interim progress is read only when the parent asks. A final summary wakes the parent to act, a blocked child's actual question becomes a parent notification, and interim progress messages do not wake the parent. [Subagents: isolation and results](https://docs.capy.ai/subagents#subagents-work-in-isolation), [How results come back](https://docs.capy.ai/subagents#how-results-come-back).

The thread UI can still show **Active** when only a subagent is working: status aggregates parent and child activity. **Waiting** means an external event owns the next move. Threads wake for CI, review, and PR events; archiving suppresses wakes, including subagent completion, while preserving pending context. Thus an active thread is not proof that its parent model is generating. [Threads](https://docs.capy.ai/threads#thread-statuses), [Archive is dormant](https://docs.capy.ai/threads#archive-is-dormant).

The streaming contract makes the distinction explicit: a `run` is one agent wake spanning model generations and tool execution until rest; a `turn` is one model generation. The documented 15-second stream heartbeat keeps an idle connection alive, not the parent model thinking. [Streaming: events and limits](https://docs.capy.ai/api-reference/streaming#events).

## Publicly documented harness structure

| Component | Documented behavior | Source |
| --- | --- | --- |
| Durable thread | Conversation and agent loop live on Capy's servers; the VM is the execution environment. Closing the laptop does not stop work. | [Threads](https://docs.capy.ai/threads), [Machines](https://docs.capy.ai/machines) |
| Child context | Child starts from its own prompt, without parent conversation history. Parent must include needed instructions and discoveries. Children can spawn further children, up to three levels deep. | [Subagents](https://docs.capy.ai/subagents) |
| Child placement | Explicitly choose shared parent machine for reading or fresh machine/checkout for writing. Isolated machines do not share a filesystem; `transfer_files` moves artifacts. | [Shared vs fresh](https://docs.capy.ai/subagents#shared-vs-fresh-machines), [Moving files](https://docs.capy.ai/machines#moving-files-between-machines) |
| Coordination | Parent drafts and starts children, reads progress on demand, handles final results and blocked questions, inspects diffs, sends targeted revisions, and can patch small problems itself. | [Results](https://docs.capy.ai/subagents#how-results-come-back), [Reviewing work](https://docs.capy.ai/subagents#reviewing-and-shipping-subagent-work) |
| External observability | API exposes task tree/transcripts and SSE. Thread SSE carries child lifecycle changes, while a separate task stream carries that child's live work. Public task endpoints are read-only; direct changes go through the thread. | [API overview](https://docs.capy.ai/api-reference/overview), [Task streams](https://docs.capy.ai/api-reference/streaming#task-streams) |

## Historical Captain restriction

Capy's **2026-02-09** article describes a narrower Captain/Build split: Captain is a read-only planner with a curated toolset; Build gets the Ubuntu VM and writes code. The article also says Captain monitors progress and can follow up when Build drifts. That is evidence for the earlier design, not a current guarantee that all parent agents are read-only. Current Subagents documentation explicitly allows the parent to patch problems and open PRs. [Captain vs Build](https://capy.ai/blog/captain-vs-build), [Current review/shipping behavior](https://docs.capy.ai/subagents#reviewing-and-shipping-subagent-work).

## Proof boundary

These sources establish automatic completion wakeups, blocked-question notifications, optional progress inspection, durable server-side orchestration, and distinct model generations. They do not establish the private queue implementation, dispatch latency, periodic parent checks, stale-child watchdogs, exact prompt/tool policy, or how notification delivery is scheduled while the parent is already generating. Do not claim any of those mechanisms from the word "monitors" alone.

Research used agent-browser to read official Markdown documentation and verify the rendered Subagents page. The former `/tasks` documentation URL redirects to `/subagents`. Agent Reach's Exa command failed because the configured MCP server `exa` is absent; official-source discovery used web search, and page reading used the required agent-browser fallback. No login, account action, authenticated execution test, or screenshots were performed. Agent Reach v1.5.0 reports up to date.
