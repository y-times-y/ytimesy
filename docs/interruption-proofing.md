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

## Digest 2026-11-25 findings (fixed 2026-11-26)

- **3 user-visible `turn-abandoned/lease-expired` (11-25 19:37:25, one sweep):** box turns with `cancel_requested=true` whose box stopped heartbeating
  at ~19:36. The takeover skips a turn asked to stop, so the sweep failed it with "The worker disconnected". Now
  `settleStoppedAbandonedTurns` settles such a turn as `cancelled` (chat idle, no error item, recorded as recovered, `stopped-executor-lost`).
  What set `cancel_requested` on all three (one was the canary chat, which people cannot stop) is not recorded anywhere: open.
- **4 `lease-takeover/box-heartbeat-lost` (11-25 23:30-11-26 00:03):** not the ASG (no scaling activity after 11-23). They began after #26 moved box
  lease renewals from the socket to HTTP; that request had no timeout, so one hung request pinned the turn's single in-flight heartbeat until the 45 s
  lease lapsed. Renewal now times out after 8 s and retries once (`TURN_BOX_RENEW_ATTEMPT_TIMEOUT_MS`).
- Not done: scale-in protection for boxes with running turns (the CPU target-tracking policy can still terminate a box mid-turn; a termination
  lifecycle hook or `SetInstanceProtection` from the box is the fix), and park-and-retry after 15 minutes.

## Machine start failures (2026-11-26)

Production, last 7 days (~2,800 turns): "could not start" 7 turns, "could not be reached" 7, "did not answer yet" 1, "worker disconnected" 8 (most on 11-25/26). Per-VM start-to-ready times are only in logs (`turn-timing` spans `vm:waitRunning`, `vm:guestProbe`), not in the database; measure the p99 from them.

Root cause of "started but did not answer yet": `waitUntilGuestAnswers` gave a started guest only ~16 s of probing, then failed the start, and that failure was not transient, so the step failed after 3 retries (red, manual Retry). Now: the probe window is ~70 s of backoff (`GUEST_PROBE_RETRY_DELAYS_MS`), "did not become running"/"started but is not answering" are `isMachineRefusalThatPasses` (step retried for 15 min, VM restarted/replaced by the existing start path), shown as "Starting your workspace…". Each retry is an `interruption_event` `machine-start-retry`; a failure after the window is `machine-start-failed` (user-visible), counted in the digest as a rate per 1,000 turns with an owner alert above 1 (`machine-failure-rate`).

Not done: Durable Object fallback for turns that do not need the VM; park-and-retry after the 15-minute window (the final text is calm and says the work is saved, but the turn is still failed); a test-only knob for a slow VM.

## Every provider-reported machine error is retried (2026-11-27)

Trigger: chat 21ddc421 saw "The chat's machine could not start: the machine provider reported an error" after 6 s. Cause: `FreestyleApiError 404 NOT_FOUND /v5/vms/<vm>` (the provider had deleted the chat's VM; 8 more VMs hit the same 404 in the 12 hours before). The retained-session branch of `bindAgentSessionMachine` called `ensureRunning` outside the replacement logic, so the 404 was thrown raw; the fallback text was the catch-all of `machineFailureReason`. Fixed: that branch falls through to replacement from the snapshot; a gone VM with no checkpoint (or no snapshot) continues on a fresh copy instead of failing.

`machineFailureRetryable` (api-turn-failure.ts) is the rule: any machine failure is waited out by the step (15 minutes, "Starting your workspace…", `machine-start-retry/<class>` rows) except terminal ones (usage allowance, rejected machine size, missing deploy setting, GitHub fetch refusal). A VM's own 400/409/410/422/5xx start failure counts toward replacement (`machineStartUnstartable`). A turn that fails after that is `machine-start-failed/ladder-exhausted/<class>` (user-visible, in the digest rate and its alert) with calm wording.

Remaining user-visible machine strings and verdicts:

| Text | Verdict |
|---|---|
| "Couldn't start / reach your workspace right now… saved" | after the ladder; calm; no Retry wording |
| "The chat's machine could not start: this deployment is missing a machine setting" / size rejected / usage limit | terminal on purpose, red |
| "Couldn't get this chat's code from GitHub. Retry in a moment…" | NOT covered (GitHub access may be revoked or the repo deleted) |
| "Couldn't set up this chat's code on its machine. Retry in a moment…" | step retried 15 min first; text still says Retry |
| "The worker disconnected…" | covered up to 10 takeovers, then red (park-and-retry open) |
| "automatic Git handoff failed" | NOT covered by this ladder (it waits for the machine first) |
| "Recovering the workspace machine…" | calm status, covered |
| "…could not start, provider at capacity, retry in a few minutes" (environment build) | NOT covered (builds, not turns) |

## Who deleted the VMs behind the 404s (2026-11-27)

Of 10 VMs with a `not found` wake failure on 11-26/27, 9 belong to chats archived in bulk (archived 11-25 23:34 to 11-26 03:07; their machines were released on purpose, the checkpoint backstop found them gone about 24 h later: noise, no live chat). The 10th (chat 21ddc421) was a brand-new chat that got its 404 8 s after creation: provider read-after-create lag, not a deletion. The retention sweep deletes only after 7 idle days, so it cannot have deleted any VM idle for hours. Non-archived chats with a `not found` since 11-16: one (b06918e6, failure 11-25 21:41 in a burst with 11 archived machines, so most likely the manual cleanup); its next message replaces the VM from the snapshot. Not knowable from the database: whether unpushed work was lost (the VM is gone; no audit files exist on the chat machine). Fixed: `readVmData` waits out about 6 s of 404 before a VM counts as gone, and the running-wait tolerates a 30 s 404 on a fresh VM.
