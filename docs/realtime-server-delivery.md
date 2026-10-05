# Server delivery rebuild

Status: development migration applied, separate Cloudflare Worker deployed, and
existing Freestyle model worker updated. Production is unchanged.
The rejected cloud branch is unmerged. This implementation starts at the verified
shared Codex/API harness cutover rather than importing that branch.

## Authority and execution

PostgreSQL owns transcripts, model history, durable turn records and task identity.
A trigger updates one delivery mailbox per conversation when progress changes.
The mailbox contains a revision and delivery lease, not repeated transcript copies.
Model workers checkpoint progress directly, without an execution-VM progress file.

The separate Cloudflare worker authenticates server requests with scoped, expiring
HMAC signatures. Each conversation has one Durable Object and one bounded current
snapshot. Snapshot replacement is transactional and monotonic; old relay retries
cannot regress the persisted or displayed revision. Reconnect seeds a missing/stale room from PostgreSQL,
so a missing DO snapshot does not require rerunning inference. Large snapshots are
chunked below Cloudflare's individual storage-entry limit.

The room also owns the live execution lease: acquire, renew, cancel and release
are transactional, scoped to owner/conversation/turn/worker lease, and survive
process restart. A second worker is rejected, cancelled leases cannot renew, and
retired turns cannot reuse still-valid signed requests. A bounded 70-second replay
window covers the 60-second request lifetime. A 30-second lease expires through an
idempotent alarm; expiry never starts inference or replays tools. Workers renew at
10-second intervals and abort if renewal fails. Durable PG fencing remains a second
check against stale writes, not an independent model scheduler. Stop intent is saved
in PG before best-effort live cancellation; an unreachable room does not lose it.
Normal completion releases the live lease before making the durable turn terminal,
so a newly submitted turn cannot collide with completion cleanup.

Queued jobs, owner-wide admission, task trees, and peer inbox records remain in PG.
This does not move all orchestration into Cloudflare or make a second copy of the
task scheduler. The next architectural stage, if needed, is event-driven task/peer
coordination and push cancellation, not another independent polling scheduler.

The authenticated web route proxies SSE to retain the existing chat UI. **This is
not WebSocket hibernation:** an open SSE connection keeps its room active. Browser
credentials and the relay signing secret never enter execution VMs. Subscriptions
expire after a minute and reconnect through application ownership checks. The
unconfigured local fallback polls PostgreSQL; it is not the production scale path.

Relay work is bounded and independently tracked. A stalled room does not hold a
database connection during network delivery or prevent healthy rooms from claiming
available relay capacity. Failed rooms retain a retry deadline across newer frames.

Model workers receive queued-turn notifications through one dedicated PostgreSQL
session connection per worker, with reconciliation polling as a recovery backstop.
Admission is serialized in a short transaction to enforce per-owner capacity across
worker processes. Model execution never holds that admission lock. Shutdown stops
new claims and waits for admitted turns; deployment stops before replacing files
if the previous process has not drained.

Fleet admission configuration (2026-10-03): `YTIMESY_MODEL_CONCURRENCY`
controls each process (default 4); `YTIMESY_FLEET_TURN_CONCURRENCY` controls
running Codex/API turns across all replicas (defaults to the local limit for
backwards compatibility). Every replica must use the same fleet and account
limits. `YTIMESY_TASK_CHILD_CONCURRENCY` separately bounds active direct children
per parent (default 3), including preparations and queued turns. Scaling the
fleet does not automatically increase a leader's fan-out. Rejected child starts
leave their drafts unchanged; root turns can queue until execution capacity is
available. The existing PostgreSQL admission transaction enforces both account
and fleet dispatch ceilings without holding a lock during inference.

This is a capacity safeguard, not a dollar budget or a 10,000-user load proof.
The model loop still runs on the existing Node worker, not Cloudflare Workflows.
VM retention cannot safely delete machines based only on age or settled-turn
checkpoints: ignored files, LFS and submodule work are not backed up by the current
format. No automatic VM deletion or infrastructure cutover is enabled here.

Repository-backed tools lazily prepare their execution VM. Coordination tools and
model safe-point peer input use server state instead. Peer acknowledgement follows
the durable model-history checkpoint. Claude keeps its existing native runtime path.
Codex/API children enqueue without VM preparation, preserving fresh writer and
stacked predecessor bindings at the first repository tool. A shared read-only child
prepares its cold parent first and uses that exact workspace, not a new writer VM.
The local workerd integration also restores a greater-than-2-MiB chunked snapshot
after stopping and restarting the entire local relay process. This verifies local
storage recovery, not remote deployment or region-loss recovery.

Cancellation wins a completion race in the terminal-state transaction. Short and
long shell commands carry a turn scope, process group and Linux process-start marker.
Cancellation marks that scope closed, terminates matching groups, escalates to KILL,
and refuses late starts. An abort listener stops owned command groups while the
model loop is awaiting a tool, rather than waiting for that loop's finalizer. A
regression test proves stop-before-finalization ordering. The Mac suite skips the Linux-only process and tmux
integration tests. A live proof on the already-running worker stopped a
TERM-resistant command, rejected a late start with exit 130, and removed its
temporary directories. The measured cancellation/check sequence was 3.723 seconds,
including remote calls and a 250 ms no-further-writes check. No VM was provisioned
or resumed and no inference was used. This is command-level evidence, not a full
user stop-button or worker-loss recovery drill.

## Development rollout evidence

- Additive migration `20261001120000_conversation_delivery` applied to the approved
  linked development project, with its migration ledger recorded atomically.
- Worker `ytimesy-realtime-development` deployed to
  `https://ytimesy-realtime-development.example-account.workers.dev`, version
  `c96d23dc-c8d4-4b05-8049-109ee6dcfc1c`.
- The existing model worker was stopped before files were replaced and restarted
  with the relay URL and signing secret. No new VM was created.
- Remote proof rejected unsigned ingress and verified signed snapshots, duplicate
  worker fencing, cancellation fencing and retired-run rejection. It used an existing
  settled conversation for streaming and a separate synthetic room for coordination;
  it did not acquire or cancel the real conversation or call inference.
- The authenticated browser progress route returned status 200, SSE content type,
  numeric revision and a progress event. The delivery backlog reached zero.
- The `--worker` proof advances only delivery metadata, waits for the deployed worker
  to settle that revision, and then reads it through the remote stream. Conversation
  content and model history are unchanged.
- Local private development configuration is generated under ignored `.ytimesy/`
  with mode 0600. Production must use explicit server environment variables. Tests
  never load this private development configuration.
- Live subscription tests on 2026-10-02 used `gpt-6.1-sol` through the normal
  submission service, deployed Freestyle model worker, and remote DO stream. Two
  completion runs delivered 53 and 47 distinct text snapshots and finished after
  intentionally disconnecting and reconnecting the subscriber. First text arrived
  in 3.607 and 7.467 seconds; these are observations, not latency guarantees.
  Two active turns cancelled through the normal stop service, settling in 1.639
  seconds and 158 ms. An explicit follow-up immediately after the second stop
  completed successfully. No reasoning summary was emitted in these low-effort
  tests; they do not verify visible reasoning or promise it for every response.
  All isolated test conversations were removed after terminal-state verification.
  No execution VM or child task was created and no API billing fallback was used.
  Reproduce with `REALTIME_MODEL_PROOF=1 node --env-file=.env --import tsx
  scripts/prove-realtime-model-turn.ts`; this explicitly runs subscription inference.

Reproduce with `scripts/deploy-realtime-development.ts --apply`,
`pnpm worker:vm`, then `scripts/prove-realtime-development.ts --worker`. These need the
existing server environment and appropriate deployment authorization; they do not
authorize production changes. Signing secrets are never in source or browser payloads.

## Remaining rollout gates

### Chat/tool lifecycle repair (2026-10-02)

The reported chat was inspected in the live browser, not inferred from screenshots.
API tool events previously discarded inputs/results, leaving bare labels. They now
persist bounded, credential-redacted evidence and render expandable details using
the same timeline inside child cards. Eight settled conversations in the affected
task tree were repaired from retained model histories/command receipts: 86 calls
recovered genuine evidence. Unrecorded older details are explicitly identified;
no output was invented and no child repository changes were integrated.

Context cleanup now retains tool call/result identities and bounds older repository
output instead of deleting delegation history. Each model step receives an
owner-scoped current child-status briefing so finished or queued children are not
mistaken for nonexistent tasks. This guides decomposition; it is not semantic
deduplication or a guarantee that the model always chooses optimal parallelism.

Tool-step/output-limit endings and missing final results cannot finalize as successful
tasks. Running follow-ups reset child state, unreviewed results say “Awaiting review,”
and wrap-up waits for cancellation to settle before attempting a new turn. Root
agents do not receive the child-only blocked-report tool. Reasoning end events settle
their timing; only actual provider-emitted summaries are displayed.

The blinking caret is removed. Streamdown's existing animation is enabled, with its
stylesheet and preserved file-link rendering when animation wraps text in spans.
Live browser checks verified expandable stored calls, restored command evidence,
review labels, and absence of the caret rule. The development model worker was
redeployed after verifying no queued/running model turns. A separate live subscription
test called `list_tasks`, saved input/result evidence, and completed with no VM or API
fallback. It emitted no reasoning summary; that remains provider-dependent. The
isolated proof chat was removed after completion. Reproduce with
`HARNESS_TOOL_PROOF=1 node --env-file=.env --import tsx scripts/prove-tool-details.ts`.

Final local verification: 211 test files passed (969 tests passed, 2 skipped);
typecheck, lint, production build, and `git diff --check` passed. The live control-plane
tool proof passed again after the final development-worker deployment. These checks
do not establish optimal model delegation or large-scale production capacity.

1. Verify VM-unavailable coordination, full user stop-button cancellation of a
   running repository tool, and forced model-worker loss/recovery through the new
   coordinator. Live model streaming, subscriber reconnect, service-level model
   cancellation and explicit post-stop continuation passed; they do not cover these
   remaining cases.
2. Measure active-session throughput, PG write/WAL load, SSE connected duration,
   snapshot bandwidth and relay lag before making a 10,000-user capacity claim.

The live checks above are not a model-provider latency guarantee, proof of full
repository-tool cancellation/worker-loss recovery, or production capacity. Full transcript
checkpoint bandwidth remains a measurement/optimization target; the bounded mailbox
eliminates outbox accumulation, not PostgreSQL WAL costs.

Primary platform references checked on 2026-10-01:
[stream cancellation](https://developers.cloudflare.com/durable-objects/examples/readable-stream/)
and [storage/runtime limits](https://developers.cloudflare.com/durable-objects/platform/limits/).
