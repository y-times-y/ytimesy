# Database connection lifecycle and capacity

## Implemented controls

- Each web or worker process owns one `pg.Pool`, shared by application queries, authentication, and pg-boss through its `db.executeSql` adapter. There is no connection per user, chat, or job.
- `DATABASE_POOL_MAX` defaults to 2 and accepts integers from 1 to 20. This is a per-process limit, not a deployment-wide limit. Change it only with a measured connection budget.
- Pool acquisition times out after 10 seconds; statements after 20 seconds; idle transactions after 30 seconds. Idle connections are released after 30 seconds and connections rotate after five minutes. Rotation does not interrupt a checked-out client.
- Application pools and queue startup promises survive development module reloads. Concurrent callers await complete queue initialization. Failed startup stops the partially initialized queue and clears the failed promise before retry.
- Web queue producers do not run maintenance, scheduling, or schema migrations. Start the separately deployed worker before accepting job submissions on a fresh database or after a pg-boss version upgrade. The worker owns these duties. Application schema migrations remain separately managed under `supabase/migrations`.
- LISTEN/NOTIFY is disabled. Queue workers poll; they do not create an extra pinned listener connection. Worker shutdown stops the queue before closing the shared pool.
- Idle-client and queue background errors are logged without SQL, payloads, or credentials.

## Deployment budget

For the current session-pooler connection mode:

`web replicas × web pool max + worker replicas × worker pool max + other clients + rollout overlap + reserved headroom <= available pooler client slots`

For example, three web processes and one worker at 2 connections each consume at most 8 slots. On a 15-slot pooler that leaves 7 for rollout overlap, operations, and other clients. This is arithmetic, not a throughput recommendation. Enforce replica caps in the chosen hosting platform; application code cannot enforce a global budget across arbitrary deployments.

Keep `DATABASE_URL` configured with verified TLS. No endpoint or Supabase capacity was silently changed by this fix. Session pooling is the existing deployment choice. For a future serverless deployment, validate transaction pooling against the entire workload before switching: explicit transactions must stay on their checked-out client, session state must not be assumed, and pg-boss migration/maintenance behavior must be tested. Do not merely rewrite the port or assume the same connection limit applies.

## Gate for 10,000 users

10,000 registered accounts, 10,000 simultaneous viewers, and 10,000 running agents are different workloads. None is certified by this connection fix. In particular, 10,000 queue-initialization calls in a unit test prove singleton behavior, not production user capacity.

Before claiming that capacity:

1. Define peak active sessions, running VMs, jobs per second, request rate, and latency/error targets. Include reconnect bursts and authentication refreshes.
2. Load-test authenticated project/session reads, event streams, job submission/claiming, and token refresh using isolated test tenants and infrastructure. Do not run a large test against live user VMs or billable inference without an explicit budget.
3. Measure `pg.Pool.totalCount`, `idleCount`, and `waitingCount`; query latency/timeouts; database CPU and locks; queue backlog/age; and HTTP errors. A small pool can still saturate. Connection timeouts bound waiting duration, not the number of incoming requests: production admission limits/rate limiting are still required.
4. Budget all replicas and rolling deployments. Size the database/pooler and set hosting replica caps from measurements, leaving operational headroom. The observed 15-slot configuration is not a 10,000-user capacity promise.
5. Inspect polling/read amplification and long transactions. Credential refresh currently holds row locks while contacting the provider; include this contention in testing. Keep inference and VM execution outside database transactions.
6. Exercise rolling restarts, repeated development reloads, failed queue startup, database outages, and recovery. Separately validate VM quotas, stream fan-out, worker concurrency, and cost ceilings.

Hosting limits, fleet-wide admission control, production dashboards, a 10,000-user workload test, and any required infrastructure upgrades remain deployment work, not completed features.

## Sources

- [node-postgres pool sizing](https://node-postgres.com/guides/pool-sizing): budget pools across all service instances and leave headroom.
- [Supabase connection methods](https://supabase.com/docs/guides/database/connecting-to-postgres): choose connection mode for the deployment environment.
- [pg-boss documentation](https://pgboss.io/): the pinned 12.31.0 package provides the custom database adapter and producer/worker configuration used here.

## Connection failures and the send's retry policy

Every request (Worker or Durable Object) has its own `pg` pool of at most 2
connections (`src/server/adapters/database-scope.ts`), each caller waiting at
most 10 s for one.

- **Log event.** Each connection failure logs one warning,
  `Request database connection failed.`, with `stage` (`connect`, `query`,
  `send-transaction`, or `client-error` for a socket that died while pooled),
  `code`, `message` (the error message only, cut to 200 characters; never SQL,
  parameters or user content), `attempt`, and the pool's `total`, `idle` and
  `waiting` counts. `total=2, idle=0, waiting>0` means the request's own
  queries were holding both connections.
- **Retry.** A failure to get a connection (`isConnectFailure`: "timeout
  exceeded when trying to connect", "Connection terminated due to connection
  timeout", `ETIMEDOUT` on connect, 57P03, 53300) happens before any
  statement ran, so the pool's promise-form `connect()`/`query()` repeat it
  twice, after 250 ms and 750 ms. `isDroppedConnection` (turn writes) is
  unchanged.
- **The send's transaction** (`enqueueApiTurn`) repeats on a connect failure
  before `begin`; after `begin` only when the send has an idempotency key (the
  gate statement then finds the turn that did land and queues nothing). A
  keyless send that failed after `begin` is never repeated.
- **Person's view.** After the last repeat the composer shows "Couldn't send
  that: the database connection timed out. Your message was kept; try again."
  (`publicFailureMessage`) and takes the typed message back.
