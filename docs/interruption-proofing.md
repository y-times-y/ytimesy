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
| 12 | Not covered by an injected test yet | | | R2 timeout, Freestyle VM boot failure, DO OOM loop, hibernation, clock skew, MCP retry live, Claude Code supervisor, side chats, helpers/subagents, program swap, fleet replacement |

Known gap: after the window (15 min) or 10 takeovers the turn is still failed (calm text, no resend wording) rather than parked and
retried forever. Owner: next step of this work (park-and-retry instead of fail).
