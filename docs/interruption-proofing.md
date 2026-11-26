# Interruption-proofing (2026-11-24)

Rule: infrastructure trouble never reaches the person. A user message is never lost; a step that fails for an
infrastructure reason is resumed from its checkpoint with backoff for up to 15 minutes; only then does anything show,
and the text says the message is saved. Code: `src/domain/turn-interruption.ts` (the one classifier and backoff),
used by `api-turn.ts` (rethrows instead of settling failed), `box-runner.ts` and `edge/executor.ts` (retry windows).
Monitoring: `docs/interruption-monitoring.md`.

## Inventory (read from code; "proof" is what runs in the repo today)

| # | Path | User saw before | Self-recovers now | Proof |
|---|---|---|---|---|
| 1 | Coordinator renew/acquire/release timeout, 5xx | red "could not confirm ownership" | yes, 15 min backoff (step) | policy tests, box-runner outage test; api-turn full-step test NOT written (hung under fake timers) |
| 2 | Chat still busy at start (`TURN_NOT_STARTED`) | "did not start… send again" | yes, resumed; after 15 min calm text, message saved | api-turn test "later step … resumed" |
| 3 | Lease lost / heartbeat unavailable abort | "Run stopped. lease was lost" | yes unless the DB says another owner (then silently dropped by reread) | policy tests |
| 4 | Box dies, lost heartbeat | none (requeue) then "worker disconnected" after 3 takeovers | yes, now 10 takeovers | PGlite scenario 2, 6 |
| 5 | DO reset / deploy / cut connection / edge 5xx | none (existing) | yes | existing api-turn tests |
| 6 | Queued message between claim and turn | lost/duplicated | yes; bug fixed: restore no longer re-inserts a delivered message | PGlite scenarios 1, 1b, 7 |
| 7 | Send races a turn start / Y² wake | error (fixed 04002d1b) | yes, queued | PGlite scenario 4 |
| 8 | Zombie running turn blocks a send | queued | yes | PGlite scenario 3 |
| 9 | Renewal gap > 45 s | stop | runner stops, sweep requeues | PGlite scenario 5 |
| 10 | Provider 429/overload, plan exhausted | failover/retry (existing) | yes | existing failover tests |
| 11 | DB pool starvation | fixed 2026-11-24 (identity-only lock calls) | yes | existing tests |
| 11a | Box turn nobody claims (all boxes draining or full) | "thinking" 16 min, no tokens (2026-11-24) | yes, after 45 s moves to the chat's object | PGlite scenario 9; live: 11 turns moved and completed |
| 11b | Chat machine busy/5xx on every tool call, or a tool call that never returns (2026-11-25, chats d8d4f7c6 and c7494835: 15 and 22 min of "working", heartbeat still renewing, load average 7.4 during a type-check; the Git handoff then failed) | silence, then "automatic Git handoff failed" | yes: calls wait for the machine with a calm "Recovering…" notice; a call running 3 min whose machine fails 2 probes is ended; the handoff waits for the machine; a machine down for ~3 min fails the step as transient (resumed up to 15 min) | `machine-recovery.test.ts` (8 fault-injection tests); live: see report |
| 12 | Not covered by an injected test yet | | | R2 timeout, Freestyle VM boot failure, DO OOM loop, hibernation, clock skew, MCP retry live, Claude Code supervisor, side chats, helpers/subagents, program swap, fleet replacement |

Known gap: after the window (15 min) or 10 takeovers the turn is still failed (calm text, no resend wording) rather than parked and
retried forever. Owner: next step of this work (park-and-retry instead of fail).

## Machine health (2026-11-25)

Liveness cannot see a hung or overloaded machine (the turn's heartbeat renews while its tool call waits), so recovery
probes the machine itself (`src/domain/machine-health.ts`, `src/server/services/machine-recovery.ts`):

- a tool call failing with a 5xx-like error starts a probe loop (a trivial `true` command, 10 s timeout, backoff 3, 6, 10,
  15, 20, then 30 s, about 3 minutes in all) with the person shown "Recovering the workspace machine…"; when the machine
  answers, the model sees the original failure and retries (reads run again by themselves);
- a call running 3 minutes (`STALL_PROBE_AFTER_MS`) is probed every minute; 2 failed probes in a row end it and start the
  same recovery; a healthy machine running a long command is never interrupted;
- the commit/Git handoff first waits for the machine to answer;
- a machine silent for the whole window fails the step as `MachineNotResponding`, now a transient failure resumed by the
  executor from its checkpoint for up to 15 minutes;
- logs `machine.recovery` (state recovering/recovered/failed) and, on the edge, `interruption_event` kind
  `machine-recovery` (counted in the daily digest).

Open: limiting the machine's own load (type-check/test concurrency, memory, `nice`, sizing up for heavy checks) is not
done; the recovery above only keeps the turn from going silent. Owner: this work, next step.
