# Turn startup incident, 2026-11-24

## Evidence and limits

A prior read-only production query identified turn `1ce46541-7d44-43ee-8551-4c34b7ad668e`, created at 19:18:11 UTC and completed at 19:35:33 UTC, with executor `node`, `run_attempts` 0, and a request counter updated at 19:35:03 UTC. These fields do not establish precisely when the first step started or why it was delayed.

Cloudflare deployment metadata shows edge executor deployments at 19:15:40.097 and 19:19:54.829 UTC and web deployments at 19:15:59.389 and 19:19:58.337 UTC, respectively. The second pair occurred while the turn was active; this temporal overlap alone does not establish causation. An observability query over 19:15–19:40 UTC filtering by the turn ID in `turnId`, `source.turnId`, `message`, and `$metadata.message` returned no matching events. This does not establish that no relevant logs exist; other fields, services, retention, or sampling could explain the absence. Box logs and exact startup timing remain unverified.

## Startup and recovery inventory

- `claimApiTurn` in `src/server/adapters/api-turns.ts` atomically changes a queued node turn to running, creates its lease and heartbeat, and applies admission limits. `TurnDispatcher` and a long-polling box client drive claims.
- The box reads session history before calling `runBoxTurn`, which in turn calls `runApiTurn`. A claim does not by itself prove a model step started.
- `requeueInterruptedBoxTurns` requeues a running node turn only after its heartbeat is stale for 45 seconds, up to the configured takeover limit. A live heartbeat does not prove first-step progress. `expireApiTurnLeases` invokes this sweep; its execution cadence is separate from the staleness threshold.
- Main commit `bc12723d` adds bounded waiting and takeover of a stale conversation coordination lock during first-step startup, and retries a start that remains blocked. That addresses a lock acquisition path; it is not evidence that this incident followed that path or that a turn stalled before reaching it is recovered in 60 seconds.
- A safe deadline for an apparently step-less turn must distinguish an actively progressing first step from a lost or wedged startup, and fence every old owner's side effects before replacement. Lease rotation or a queue update alone is not sufficient proof against duplicate external effects. Recovery must also respect active code restore, cancellation, and the existing uncertain-tool-result protocol.

No production change or deployment was made as part of this inventory. The 60-second recovery and its fault-injection proof remain outstanding.
