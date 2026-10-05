# Hosting the ytimesy model worker

Retrieved **2026-10-03**. USD public list prices; primary sources only. This is a hosting comparison, not a deployment or measured production bill. Scope: the continuously running TypeScript/Node model loop, pg-boss jobs, PostgreSQL notifications, API inference and remote Freestyle tool calls. Execution VMs, model tokens, Supabase, storage, frontend hosting, and unrelated account usage remain separate costs.

## Decision

**The existing worker can move to a managed Node container with substantially less application change than a Workers migration.** Railway is a straightforward candidate; Cloud Run **worker pools**, rather than request-based services, explicitly support continuous pull consumers. Cloudflare **Containers** also preserve the Node process, but need explicit startup/restart supervision and inactivity configuration. None removes the need for recoverable agent turns.

**Workers + Durable Objects + Workflows are a plausible longer-term architecture, not a drop-in host.** Keep Durable Objects for leases, cancellation and reconnectable delivery, and model durable work as bounded Workflow steps. Moving a 30-minute stream into an ordinary Worker, alarm, or one oversized Workflow step does not establish independent background execution or safe replay. The current architectural scope is documented in [PLAN.md](../../PLAN.md).

## Runtime fit

| Option | CPU, memory and wall time | Existing Node/pg-boss worker | Restart and recovery |
| --- | --- | --- | --- |
| Workers Paid | 128 MB per isolate; HTTP CPU default 30 s, configurable to 5 min. HTTP wall time has no hard cap while caller remains connected; `waitUntil` extends execution only 30 s after completion/disconnect. Cron, Queue and DO alarm wall time is 15 min. | Event-driven runtime; cannot assume a forever polling process. | Runtime updates can terminate long requests after a 30 s grace period. Persist progress independently. [Limits](https://developers.cloudflare.com/workers/platform/limits/) |
| Durable Objects | Workers runtime; default 30 s CPU per invocation, configurable to 5 min. RPC/HTTP wall time depends on connected caller. | Good per-conversation coordinator; moving polling/notification clients requires a lifecycle redesign. | In-memory state can disappear on eviction; constructor restores persisted state. Pending work/timers prevent hibernation. [DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/), [lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/) |
| Workflows Paid | Limits table says unlimited step wall time and 30 s default/5 min configurable active CPU per step. 1 MiB ordinary step result, 1 GB persisted state per instance, 10,000 default steps/configurable to 25,000. | Use explicit durable model/tool steps; not an unchanged pg-boss daemon. | Completed step results support continuation, but failed steps can repeat external effects. Default step timeout is 10 min with five retries. [Limits](https://developers.cloudflare.com/workflows/reference/limits/), [retry configuration](https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/) |
| Cloudflare Containers | Linux/amd64 container in a microVM. `basic`: 0.25 vCPU, 1 GiB RAM, 4 GB disk. `lite`: 1/16 vCPU, 256 MiB RAM, 2 GB disk. Larger/custom types available. | Full Node process; pg-boss can stay. Configure continuous lifecycle explicitly. | Stop/rollout/process exit require restart supervision; disk ephemeral by default. Shutdown sends SIGTERM then waits up to 15 min before SIGKILL. [Sizes](https://developers.cloudflare.com/containers/platform/limits/), [lifecycle](https://developers.cloudflare.com/containers/concepts/architecture/) |
| Cloud Run worker pool | Continuous non-HTTP background processing, always allocated CPU. At least one instance required; no built-in automatic scaling. CPU minimum 1, maximum 8; 1 vCPU permits 512 MiB–4 GiB. | Container entrypoint can remain the Node worker; ordinary PostgreSQL drivers and TCP connections remain available. | Instances can stop during active work; SIGTERM grace 10 s. Local writable filesystem is memory-backed and disposable. [Overview](https://docs.cloud.google.com/run/docs/overview/what-is-cloud-run#cloud_run_worker_pools), [CPU limits](https://docs.cloud.google.com/run/docs/configuring/workerpools/cpu), [runtime contract](https://docs.cloud.google.com/run/docs/container-contract) |
| Railway paid container service | Standard long-running service; documented Hobby service maxima include 48 GB RAM/48 vCPU across replicas. This is not a function duration limit. | Node worker start command and PostgreSQL connection can remain. | Default restart policy is On Failure, maximum 10 restarts; choose Always on paid plans. Keep Serverless/app sleeping disabled for a queue consumer. [Plans](https://docs.railway.com/pricing/plans), [restart policy](https://docs.railway.com/reference/restart-policy), [Serverless](https://docs.railway.com/reference/app-sleeping) |

**Workflows documentation needs careful interpretation.** The limits table describes unlimited wall time, but the [Rules of Workflows](https://developers.cloudflare.com/workflows/build/rules-of-workflows/#limit-timeouts-to-30-minutes-or-less) instructs authors to keep step timeouts at 30 minutes or less and use `waitForEvent` for longer waits. Pricing says CPU can be configured up to five minutes “per Workflow,” whereas limits describes it per step. Treat these as documentation discrepancies to verify in a compatibility proof, not permission to run an entire 30-minute turn in one durable callback. Use smaller steps with deliberate timeout/retry policies.

## Published prices and explicit examples

All examples are calculations from stated assumptions, **not measured ytimesy utilization**. Included allowances are shared at the account/billing scope; the examples assume none has already been consumed. Container capacity is not a claim that the selected memory is sufficient.

### Current Freestyle baseline and Fly.io alternative

Read-only Freestyle inventory on 2026-10-03 confirmed `ytimesy-job-worker` is running with 2 vCPU, 4 GiB RAM and 16 GiB disk. Published allocated-resource rates are $0.04032/vCPU-hour and $0.0129/GiB-hour. At 730 running hours, CPU plus RAM totals **$96.54** gross; **$83.31** if the shared 200 vCPU-hour and 400 GiB-hour allowances are wholly available. This is not an invoice: storage, network, plan minimums/credits and other account workloads affect the actual payment. Free-plan allowances are hard caps, not permission to run continuously into paid usage. [Freestyle pricing](https://www.freestyle.sh/docs/vms/pricing-and-limits)

Fly.io lists an always-on shared-CPU machine with 1 GB RAM at **$6.70/month** in Ashburn; other regions differ. A 2-shared-CPU/2-GB example is $13.39/month. This preserves a Linux/Node process but **does not eliminate a VM**; shared CPU is not equivalent to dedicated capacity. Network, volumes and other resources are extra. No load test establishes either size as sufficient for ytimesy. [Fly.io pricing](https://docs.fly.io/about/pricing)

### Workers and Workflows

Workers Paid has a **$5/month account minimum**, 10 million requests and 30 million CPU-ms included; overages $0.30/million requests and $0.02/million CPU-ms. Waiting on inference/network I/O is not active CPU, and Workers have no egress charge. [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)

Workflows shares those request/CPU allowances and adds **500,000 steps/month**, then $0.80/100,000 steps, plus **1 GB-month state**, then $0.20/GB-month. Step/storage billing began August 10, 2026; old claims that these dimensions are free are outdated. Waiting on an API or `step.sleep` does not consume CPU. [Workflows pricing](https://developers.cloudflare.com/workflows/reference/pricing/)

Illustration: 10,000 turns/month × 20 steps/turn = 200,000 steps; **assumed** 1,000 CPU-ms/turn = 10 million CPU-ms; 10,000 Workflow invocations. These fit the published included quantities, so the Workers/Workflows subtotal is $5 **only if** other usage and retained state also fit. No measured CPU or step count supports an all-in $5 prediction.

### Durable Objects

Paid includes 1 million requests/month, then $0.15/million; 400,000 GB-s duration/month, then $12.50/million GB-s. Billing uses 128 MB per object, including while waiting on I/O when it cannot hibernate. SQLite includes 25 billion reads, 50 million writes and 5 GB-month; overages $0.001/million reads, $1/million writes and $0.20/GB-month. [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)

One resident object for 730 hours uses `730 × 3,600 × 0.128 = 336,384 GB-s`, fitting duration allowance if otherwise unused. Ten independently resident objects use 3,363,840 GB-s: approximately $37.05 duration beyond allowance, before provider billing rounding, requests and storage. Conversation concurrency therefore matters. A streamed SSE response/pending inference is not a hibernated WebSocket; do not apply hibernation savings to the current delivery path without changing and verifying it.

### Cloudflare Containers

Paid includes 25 GiB-hours RAM, 375 vCPU-minutes active CPU and 200 GB-hours disk/month. Above these: **$0.0000025/GiB-second provisioned RAM**, **$0.000020/vCPU-second active CPU**, **$0.00000007/GB-second provisioned disk**. Workers and DO usage is additional; North America/Europe egress includes 1 TB/month, then $0.025/GB. [Container pricing](https://developers.cloudflare.com/containers/platform/pricing/)

For **one `basic` instance running 730 hours**, allocated RAM costs `(730−25)×3,600×0.0000025 = $6.345`; disk costs `(4×730−200)×3,600×0.00000007 = $0.68544`. With **assumed average active CPU 0.025 vCPU**, CPU costs `(0.025×730×3,600−375×60)×0.000020 = $0.864`. Add the shared $5 plan minimum: **$12.89**, excluding DO overages, logs, egress and other usage. If the plan minimum is already paid, it is not another $5 for this container. No profiling establishes 1 GiB as sufficient.

The container is started and addressed through a DO. New applications are directed toward the direct DO Container API. The older `Container` class defaults `sleepAfter` to 10 minutes, keyed to incoming activity; outbound PostgreSQL polling must not be mistaken for activity that keeps that controller awake. Explicitly configure lifecycle and test restart. [Container lifecycle](https://developers.cloudflare.com/containers/concepts/architecture/), [Container class](https://developers.cloudflare.com/containers/api/container-class/)

### Cloud Run worker pools

For **us-central1 on-demand**, worker pools cost **$0.000011244/vCPU-second** and **$0.000001235/GiB-second**, including 384,204 vCPU-seconds and 728,744 GiB-seconds/month at that pricing basis. These are worker-pool rates, not HTTP request-based or instance-based service rates. [Cloud Run pricing](https://cloud.google.com/run/pricing#worker_pools)

One **1 vCPU/512 MiB instance for 730 hours** costs `2,628,000×(0.000011244 + 0.5×0.000001235) = $31.17` gross compute; **$25.95** if the published free allowances are wholly available. One **2 vCPU/4 GiB** instance costs **$72.08** gross / **$66.86** with those allowances. Allocated CPU is charged even while inference waits. These exclude network transfer, image registry/builds, logs and other Google resources; free allowances are aggregated across billing-account projects.

### Railway

Hobby minimum **$5/month including $5 usage**; Pro minimum **$20 including $20 usage**, not subscription plus the full usage bill. Published container rates: RAM **$10/GB-month**, active CPU **$20/vCPU-month**, egress **$0.05/GB**, volume storage **$0.15/GB-month**. Railway VM/sandbox rates are different and should not be substituted for container rates. [Plans and resource pricing](https://docs.railway.com/pricing/plans)

For a normalized published-rate month, **assumed measured RAM 0.5 GB and average CPU 0.025 vCPU** give `$5 + $0.50 = $5.50` usage. Hobby total is approximately **$5.50**, Pro total **$20**, before other usage. Unlike Cloud Run's allocated vCPU pricing, actual CPU consumption determines this example. Real memory/CPU measurements are required before choosing capacity or estimating a bill; per-minute metering can differ from normalized monthly illustrations.

## Compatibility and recovery gates

Cloudflare explicitly supports `pg` with `nodejs_compat`; Hyperdrive requires pg **8.16.3 or newer** and recommends creating a client per request, with underlying pooling handled by Hyperdrive. This establishes database-query support, **not compatibility of a continuously polling pg-boss consumer or a dedicated long-lived LISTEN connection**. [Official pg guide](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-drivers-and-libraries/node-postgres/)

The [pg-boss upstream](https://github.com/timgit/pg-boss) describes Node/PostgreSQL execution, SKIP LOCKED job claims, retries and non-Node SQL APIs. Preserve its job tables for a minimal container move. For Workers/Workflows, prove the chosen invocation model, PostgreSQL transactions, non-cached queue reads and notification delivery rather than assuming `pg` support proves daemon compatibility.

The parent investigation identified the current model transport's `undici` custom DNS lookup for public-address enforcement and origin pinning. A Workers port must preserve that behavior through an explicit compatible adapter; replacing it with native `fetch` without equivalent checks is a security regression. Verify AI SDK streaming, TLS/database connectivity, provider endpoint validation, cancellation, secret scope, progress delivery and concurrent turns before cutover. No live provider-host compatibility test was performed for this note.

**Durable job claims do not make inference and remote shell effects exactly once.** A crash after provider acceptance or a VM tool mutation but before recording completion can repeat paid inference or a destructive tool action. Workflows explicitly recommends idempotent steps. Use stable turn/model-step/tool IDs, persisted intent and results, remote receipt/status checks where available, and explicit uncertain-outcome handling where the provider cannot deduplicate. Bound retries per effect rather than replaying a whole agent turn. [Workflow idempotency guidance](https://developers.cloudflare.com/workflows/build/rules-of-workflows/#ensure-apibinding-calls-are-idempotent)

For any container host, test process kill mid-stream, deployment restart, PostgreSQL connection loss, notification reconnection, lease expiration, duplicate consumers, Stop during remote tools, and resume from the last committed model step. Checkpoint correctness is the prerequisite for cheaper hosting; larger restart grace periods alone do not provide it.
