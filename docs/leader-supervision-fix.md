# Leader supervision and child-card placement

> **Retired (2026-10).** The lead/child task architecture this describes was removed. The root chat is the builder; it delegates only through builder subagents (`agent`/`agent_send`, docs/builder-tool-surface.md). Kept for history; do not implement from it.

Development fix, 2026-10-02. No schema migration, new VM, or API fallback.

## Behavior

- API and Codex-subscription completion/failure events immediately enqueue the existing durable task-event job. Event identities include the turn ID so identical results on separate turns are not discarded.
- Active parents consume notifications through their existing safe-point mailbox. Idle parents start a normal internal wake-up turn. Consumption is checkpointed before acknowledgement; an unconsumed notification falls back to an idle wake-up. This does not interrupt a tool or modify already streamed text.
- A two-second event recovery pass supplements direct jobs; the minute schedule remains a durable backstop. Finalized or worker-lost child turns missing an event are recovered in bounded batches without replaying tools.
- A thirty-second supervisor checks quiet children after two minutes and long-running children at five and ten minutes. There are at most three acknowledged check-ins per child turn, retained through mailbox receipts across worker restarts. The leader decides whether to read activity, request a summary, steer, or leave healthy work alone. No child is automatically replaced or cancelled.
- Supervision uses server turn records for API/Codex children and recorded prompt timing for native children. Legacy native turns without timing are not assigned invented start times. Native active-parent delivery uses the existing hook mailbox; that path is unit-tested, not newly live-verified.
- An idle leader with active children displays “Waiting for child agents”, not fake thinking.
- Child cards anchor to recorded `create_task` results. Legacy calls without results use the recorded owning prompt's delegation block. Missing evidence never falls back to the first message. New queued prompts persist timing.

## Verification

The failing regression command reproduced wrong first-prompt placement, absent immediate completion enqueue, and missing failure notifications before the fixes. Regression tests also cover active-parent safe points, acknowledgement, idle races, native mailbox routing, payload bounds, bounded supervision, stopped-child revalidation, and worker-loss event recovery.

Full suite: 213 files, 985 tests passed, 2 skipped (`pnpm exec vitest run --maxWorkers=2`). Unbounded parallel execution caused unrelated database initialization and Git test timeouts; the bounded full rerun passed. Typecheck, lint, build, and diff whitespace checks passed; subsequent targeted verification covers final refinements.

Live subscription test (`LEADER_WAKEUP_PROOF=1 node --env-file=.env --import tsx scripts/prove-leader-wakeup.ts`) created an isolated parent and read-only child. The child finished, the deployed worker woke the parent, and the parent returned the exact observation marker. Event delivery latency was 1,190 ms initially and 875 ms after the final deployment. No new VM or paid API inference was used. Test conversations were removed.

The reported real conversation had two historical prompt timings missing. `scripts/repair-child-card-timing.ts` recovered them from exact stored turn creation timestamps, only after the chat settled, with an optimistic transcript comparison and active-turn exclusion. Text was not changed. Agent-browser verified all seven cards follow the delegation work block rather than the initial unrelated message. Screenshots remain outside the repository.

Recovery also delivered a previously missed real child failure. The real leader resumed coordination, followed up with its existing child, and subsequently reviewed and accepted its patch. This is observed development behavior, not a guarantee of autonomous implementation quality or production-scale capacity.
