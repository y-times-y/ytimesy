# Backend efficiency assessment — 2026-10-07

## Decision

Keep PostgreSQL, Effect, the Node executor, Freestyle execution VMs, and the
Cloudflare conversation coordinator. Do not introduce NATS or Kubernetes solely
to match Capy's stack. The existing topology has useful safety boundaries, but
its efficiency and production capacity are not established. Optimize progress
persistence/delivery and idle coordination first, then measure concurrent load
and failure recovery. This assessment changes no runtime or database configuration.

## Evidence boundaries

- Inspected current checkout's dispatch, admission, progress persistence, relay,
  Durable Object, workflow receipts, database pool, queues and worker deployment.
- The checkout already had unrelated modified files; they were left untouched.
- Read-only queries against the configured database ran in read-only transactions
  with five-second statement limits. No transcript contents, owner IDs, credentials
  or query payloads were printed. This is a small development-workload snapshot,
  not production capacity evidence.
- Seven existing test files passed, totaling 33 tests. These include the local
  workerd realtime integration and PGlite workflow receipt checks; they are not
  live remote failure or load tests.
- No inference, VM provisioning, deployment, migration, or paid load test ran.
- Capy's stack is its public recruiting description, not inspected source or a
  measured competing system: https://capy.ai/careers/bd60cf12-18f4-473e-acd4-aa62ae859388

## Findings and priorities

### 1. Progress snapshots amplify writes and transfer — high priority

`publishApiTurnProgress` writes the entire displayed item array to both `api_turn`
and `agent_session`. It correctly avoids rewriting model messages on each text
delta. The progress writer coalesces updates when storage is busy, but has no fixed
time/byte cadence: fast writes can still persist many small changes. Updating
`agent_session` triggers delivery revision updates. The relay reads the item array,
posts a complete snapshot, and the DO stores the complete snapshot in chunks and
broadcasts it to subscribers.

The configured DB held 12 sessions: item payload text averaged 125,099 bytes and
reached 389,752 bytes. Delivery backlog was zero at observation time. PostgreSQL
cumulative counters since the August 25 statistics reset showed 37,610 updates on
`agent_session`, 54,761 on `api_turn`, and 49,011 on `conversation_delivery`.
These counters mix previous proofs and other application activity; they do not
establish current rates or attribute all writes to text streaming.

The session owner index includes `updated_at`, which progress writes change.
Session HOT updates were 104 of 37,610 updates, consistent with indexed-field
changes requiring index maintenance. Table size and HOT counters are not a direct
measurement of WAL bytes or bloat.

Recommendation: versioned sequenced live deltas, bounded flush cadence, compact
reconnect snapshots, and durable model/tool checkpoints with immediate critical
state persistence. Avoid using token progress to reorder the sidebar every time.
Define permissible loss of uncheckpointed display text and stale/missing delta
recovery explicitly. Persist cancellation, receipts and terminal transitions with
their existing fencing guarantees. Benchmark before selecting cadence values.

A synthetic serialization illustration called the existing `conversationEvent`
function with 500,000 bytes of retained history and 1,000 updates of 64 bytes:
full frames totaled 532,230,893 bytes. Proposed JSON delta envelopes totaled
127,893 bytes; including an assumed 500,000-byte initial history gives about
0.628 MB rather than 532 MB. This excludes a complete initial envelope, periodic
checkpoints, retries, compression and protocol overhead. It is not a benchmark of
an implemented delta path or a production savings estimate; actual coalescing
changes delivered update counts.

### 2. Existing progress notifications are not consumed — high priority

The delivery trigger already emits `ytimesy_progress`. The model dispatcher listens
to `ytimesy_turn_queued`, but the relay checks every 250 ms. In steady idle operation
with realtime configured and capacity available, this means approximately 345,600
relay claim checks per day per process. Model admission also has one-second
reconciliation wakeups. Multiple replicas multiply this work. pg-boss explicitly
sets `useListenNotify: false` and has its own polling.

Recommendation: consume progress notifications, coalesce wakeups and keep a slower
bounded reconciliation fallback. Notify after durable state commits. Treat missed
notifications as latency, not lost work. Verify pinned pg-boss support and custom
database adapter compatibility before changing its configuration. This can address
idle work without adding a new message broker.

### 3. SSE keeps idle rooms active and periodically reconnects — medium priority

The DO uses SSE with heartbeat timers, not hibernated WebSockets. Authorization
expires each stream after 60 seconds, causing ownership revalidation/reconnect.
There is an explicit limit of 16 subscribers per room and a 4 MiB delivery envelope
limit. These are intentional bounds to incorporate into product capacity targets.

Recommendation: measure connected-room idle duration and reconnect request volume.
Evaluate hibernating WebSockets if idle connections materially affect cost. They
reduce idle duration charges, not active-stream work. Preserve authorization
expiry/revocation and monotonic reconnect behavior when changing transport.

Primary references:
- https://developers.cloudflare.com/durable-objects/best-practices/websockets/
- https://developers.cloudflare.com/durable-objects/platform/pricing/

### 4. More workers do not automatically mean more execution capacity — medium priority

Fleet admission uses one short global advisory transaction lock, an indexed queued
turn search, and running-turn counts. This protects limits across processes. The
default fleet capacity follows the local worker limit (4). Replicas must share an
explicit fleet limit. The shared database pool defaults to 2 connections per
process and serves application queries and pg-boss. The notification listener uses
a separate session connection. Short statements help, but pool wait and admission
contention under load have not been measured.

Recommendation: instrument pool wait, admission retries, queue age, heartbeat
latency and per-owner fairness. Increase pool/capacity only within the DB connection
budget. At measured contention, consider maintained capacity counters or partitioned
admission while preserving owner/fleet limits. NATS cannot eliminate database
admission or recoverability requirements.

### 5. Workflow durability still depends on the Node executor — medium priority

The workflow sends each model step to the Node executor over signed HTTPS. The
executor claims a PostgreSQL receipt, calls providers/tools and records its outcome.
This adds a network/receipt boundary per step and does not eliminate always-on Node
compute. Completed-step replay is fenced; uncertain processing steps fail closed,
so automatic recovery of an unknown side effect is deliberately not promised.
The direct edge executor remains a staged prototype in the repository docs.

Recommendation: measure inter-step orchestration delay separately from inference
and VM-tool delay. Prove executor loss before inference, during a tool, and after
a known result but before response delivery. Do not remove safety receipts just to
reduce overhead or claim Kubernetes restarts recover uncertain edits.

### 6. Worker responsibilities share one deployment — medium priority

The worker hosts dispatch/execution, queue jobs, delivery, supervision and VM fleet
maintenance. Provisioning scripts describe one named always-on worker VM. Code has
replica-safe admission and delivery leases, but this review did not verify a live
multi-replica deployment or process CPU/RSS under mixed workloads.

Recommendation: containerize and add explicit role entry points when independent
scaling or operational isolation is needed. Validate graceful shutdown within the
chosen host's termination deadline. A managed long-running container service can
be evaluated before operating Kubernetes. Keep execution VMs separate from trusted
backend containers; ordinary containers are not a drop-in replacement for the
current untrusted-code sandbox boundary.

## NATS and Kubernetes decision gates

NATS: reconsider if optimized existing wakeups/relay still miss delivery targets,
or cross-worker routing complexity becomes substantial. First decide whether each
event requires ephemeral or durable delivery. Core NATS is at-most-once;
JetStream adds persistence/redelivery, requiring consumer idempotency. Adding it
without changing snapshots retains the principal payload amplification.
Reference: https://docs.nats.io/concepts/jetstream

Kubernetes: reconsider when worker scheduling, deployment, resource allocation or
fleet operations demonstrably exceed a simpler managed container host's capabilities.
It replaces worker-hosting machinery, not PostgreSQL, application fencing,
Cloudflare coordination, or execution-VM isolation by itself.
Reference: https://kubernetes.io/docs/concepts/workloads/controllers/deployment/

## Next verification campaign

Use a disposable environment with synthetic data and stubbed provider responses
before paid inference. Test 1, 10 and 50 active turns, with short and long retained
histories, slow/disconnected subscribers and stopped/restarted executors. Define
targets before optimizing. Capture queue wait and relay lag p50/p95/p99, pool wait,
SQL calls/WAL volume, bytes per update, CPU/RSS, connected duration and error rate.
Require no lost critical transitions, no stale writes and no blind replay of
uncertain side effects. Compare changes individually with the same workload.

Tests run:
- src/server/jobs/turn-dispatcher.test.ts
- src/server/jobs/conversation-delivery.test.ts
- src/server/services/turn-progress-writer.test.ts
- src/server/adapters/api-turns.test.ts
- src/server/jobs/model-workflow-executor.test.ts
- tests/realtime-worker.test.ts
- tests/model-workflow-steps.test.ts
