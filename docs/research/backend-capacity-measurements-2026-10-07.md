# Backend capacity measurements — 2026-10-07

## Conclusion

The current progress pipeline has measurable database write amplification. Short
local runs delivered small-history progress promptly, but 30-second runs at 25 and
50 sessions with 512 KB histories produced multi-second p95 delivery latency.
More Node workers or Kubernetes would not independently solve this shared database
work. The experiment does not establish a maximum production user/agent count.

Keep the existing default fleet limit of 4 until the optimized path passes a
deployment-matched test. This is a conservative configuration recommendation, not
proof that four full model/tool turns meet a production SLO. Define the SLO first;
this report uses one-second p95 live progress as a provisional comparison target.

## Measured results

PostgreSQL 17.11, constrained to 2 CPUs and 1 GiB RAM in an isolated Docker
container; Node and local workerd ran on the host Mac. Each session had one
continuously reading subscriber and offered two updates per second. The application
pool had two connections. Payload histories were high-entropy base64, preventing
an unrealistically favorable result from repeated-character compression.

| Sessions | Retained history/session | Offered duration | Save p95 | Delivery p95 | Final/terminal frames | Errors |
| --- | --- | --- | --- | --- | --- | --- |
| 4 | 128 KB | 6 s | 34 ms | 287 ms | 4/4 | 0 |
| 10 | 128 KB | 6 s | 54 ms | 290 ms | 10/10 | 0 |
| 25 | 128 KB | 6 s | 109 ms | 309 ms | 25/25 | 0 |
| 50 | 128 KB | 6 s | 294 ms | 895 ms | 50/50 | 0 |
| 10 | 512 KB | 6 s | 183 ms | 354 ms | 10/10 | 0 |
| 25 | 512 KB | 30 s | 2,394 ms | 2,825 ms | 25/25 | 0 |
| 50 | 512 KB | 30 s | 2,635 ms | 3,631 ms | 50/50 | 0 |

Duration excludes admission/setup and final drain. All subscribers received both
the last sequence and completed state. This checks progress terminal delivery, not
model correctness, tool receipts or external side effects. Counts above are local
synthetic sessions with raised admission limits, not full agent turns dispatched
through the production worker. Current unoverridden fleet admission defaults to 4.

At 25 large-history sessions, 1,500 updates were offered and 1,089 progress writes
completed. The relay made 562 publications, including initialization and completion,
transmitting 275 MB of uncompressed JSON. PostgreSQL generated 1.34 GB WAL over
about 31 seconds. At 50 sessions, 3,000 offers coalesced into 1,620 progress writes;
324 relay publications transmitted 140 MB and generated 2.04 GB WAL over about
33 seconds. Coalescing discards superseded intermediate frames while retaining the
latest state; fewer bytes at 50 are not better throughput. These are fixture totals,
not an invoice estimate or expected production bandwidth.

The event-loop p95 stayed around 11 ms. One Docker snapshot during the run showed
PostgreSQL using approximately 150% CPU and 194 MiB memory. This supports SQL/storage
pressure as a likely contributor, but does not isolate CPU, Docker disk performance,
autovacuum, serialization and connection wait into separate causes. The Mac and
local database hardware do not match the deployed environments.

An earlier PostgreSQL 13 smoke run without terminal-state publication found the
same direction: 50 sessions at 512 KB had 3,301 ms p95 delivery over a short run.
Its raw data is retained separately; it is not a controlled repeat of the final
PostgreSQL 17 experiment.

## What was actually exercised

- Existing `claimApiTurn` SQL, with explicit higher fixture fleet limits.
- Existing `turnProgressWriter` and `publishApiTurnProgress`, including both item
  writes and the repository's actual delivery trigger migration.
- Existing delivery claim/settle adapters and a 250 ms relay cadence with batches
  of 16. The fixture awaits a batch before claiming another; production allows
  up to 16 independent in-flight requests and can refill vacancies earlier.
- Actual signed HTTP ingress, snapshot chunk persistence, monotonic SSE delivery
  and subscriber backpressure in the local Cloudflare workerd runtime.
- Existing `finishApiTurn`, and final snapshot plus terminal status delivery.
- The fixture uses the relevant table columns, constraints and owner/turn/delivery
  indexes. It does not reproduce the entire application schema or historical data.

The harness inserts fixtures directly rather than using public onboarding/enqueue
routes. It has an extra two-connection observer pool for setup, WAL reads and backlog
counts; those reads add some measurement load. All application progress/admission/
delivery adapters share the two-connection scoped application pool. All readers are
healthy. Cases run sequentially in one DB/worker lifetime, so cache, checkpoint and
vacuum effects are not reset between cases. These are stress observations, not
statistically repeated, deployment-matched capacity measurements.

Missing: real model streaming, VM boot/resume/provisioning, repository tools, native
Claude execution, workflow HTTPS round trips, task trees/peer delivery, frontend
rendering, WAN latency, cold recovery, slow readers and multi-process scaling.
Do not interpret 50 passing terminal frames as support for 50 production agents.

## Read-only current environment checks

The local environment file matches the effective Freestyle key used for inspection.
Its account returned four VMs, all paused, and a specific query for
`ytimesy-job-worker` returned none. No VM was created, resumed or modified remotely.
This does not rule out services in another account/host; an active worker under the
inspected configuration was not verified. Old deployment documentation must not
be treated as current worker availability.

The local environment has no overrides for model/fleet/user concurrency or database
pool size: code defaults are 4/4/8/2 respectively. Remote process configuration was
not inspected and may differ.

A bounded read-only remote database probe ran 100 `SELECT 1` calls per tier through
a two-connection pool. p95 response including pool wait was 58 ms at 4 concurrent
callers, 133 ms at 10, 341 ms at 25 and 656 ms at 50. Each warmed burst completed in
about 1.3 seconds; the first took 1.5 seconds. These are trivial read/socket/pool
observations, not application throughput or SQL write timings. No live DB writes,
schema changes or transcript contents were used by this probe.

## Next decisions

1. Implement bounded progress persistence and sequenced delta delivery, retaining
   durable receipts, terminal state and reconstructable checkpoints.
2. Consume existing progress notifications, with a slower recovery sweep.
3. Measure configured pool wait and locate/verify the actual worker deployment.
4. Repeat a deployment-matched sustained run at the intended launch concurrency,
   including worker loss, provider/VM limits and real repository activity. Select
   explicit latency/error/cost targets and spending caps for model/VM tests.
5. Evaluate worker hosting only after separating application, DB and provisioning
   limits. NATS does not remove snapshot writes. Kubernetes does not increase
   database throughput or make uncertain tool replay safe.

## Reproduction and artifacts

Script: `scripts/measure-backend-capacity.ts`. It rejects non-local URLs and requires
the explicitly named disposable database `ytimesy_capacity_fixture`. Run against a
fresh isolated Postgres container with a unique name, create that database, and pass
its loopback URL in `CAPACITY_DATABASE_URL`. Do not load the application's `.env`.
Example invocation after preparing the disposable database:

```sh
CAPACITY_DATABASE_URL='postgresql://postgres:local-capacity-only@127.0.0.1:PORT/ytimesy_capacity_fixture' node --import tsx scripts/measure-backend-capacity.ts
```

The original measured runs used the default `postgres` database in dedicated
task-created containers. The reusable guard was tightened afterward to require
the dedicated database name; it changes no measured queries. Both task-created
containers and their anonymous data volumes were removed after the runs. Local
workerd persistence directories were removed. No paid inference or remote compute
was used. The script passed TypeScript checking and its targeted Biome check.

Raw PostgreSQL 17 results: `backend-capacity-2026-10-07.json`.
Earlier PostgreSQL 13 smoke: `backend-capacity-2026-10-07-pg13.json`.
