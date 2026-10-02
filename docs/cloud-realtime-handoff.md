# Cloud realtime architecture handoff

## Goal

Implement the approved hybrid architecture while preserving the current UI and
shared harness. The user authorized cloud continuation and this handoff branch.
Read AGENTS.md, PLAN.md and the self-documenting-code skill before changes.
Current architecture evidence is in codex-subscription-harness-proof.md.

## Approved direction

- Keep PostgreSQL authoritative for ownership, transcripts, turn leases and outbox.
- Add one Cloudflare Durable Object per agent conversation for authenticated live
  delivery and bounded cursor-based replay, not a competing task scheduler.
- Keep the shared model loop in scalable Node workers. Codex subscription and API
  adapters use that loop; native Codex is device-code login/legacy recovery only.
- Keep Freestyle for repository tools, setup, terminal and desktop. Stream model
  events directly from the worker rather than through execution-VM progress files.
- Reuse private encrypted object-storage checkpoints and existing task orchestration.

## Implementation order and proof

1. Add direct ordered worker-to-conversation delivery and browser reconnect replay.
   Test authorization, duplicates, stale turns, slow consumers, missing cursors,
   cancellation, child cards and browser closure. Preserve legacy adapter behavior.
2. Add immediate durable-turn wake notifications with polling/reconciliation as a
   recovery backstop. Begin model activity independently of VM startup; await the
   executor only for tools requiring it. Display honest preparation status, never
   fabricate reasoning before the provider emits it.
3. Make worker concurrency configurable, add per-user fairness and lease fencing,
   and implement drain-safe deployment. No automatic replay of uncertain shell
   writes, publication or model requests after a crash.
4. Verify typecheck/lint/build, targeted and full tests, actual browser streaming,
   restart/disconnect recovery and measured concurrency. Report mocked versus live
   evidence separately. Commit/push a reviewable branch; do not merge other branches.

## Verified starting point

The local cutover was deployed to the existing durable worker. Live subscription
turn continuation, repository tools, persisted context and one shared read-only
child completed. Native runner is paused with automatic restart off; preserve its
history. Five superseded build VMs were removed with snapshots retained; two test
executors were also removed. Existing workspaces/templates were preserved.

Typecheck, lint, build and 32 targeted tests passed. A prior full run had 939
passing tests, one skipped test and one existing Git broker timeout; its isolated
rerun passed. This is not a load-test or a claim of 10,000-user capacity.

## Infrastructure and access

Repository: y-times-y/ytimesy, handoff branch codex/cloud-realtime-handoff.
Local ignored .env, certificates and device tokens are not in Git or this note.
Use only credentials provided through the cloud environment's secret facilities.
If deployment access is missing, finish implementation and local/emulated proof,
then report the precise deployment blocker rather than claiming live completion.
New persistent compute or new paid inference requires an explicit spending budget.
Existing development infrastructure may be inspected; preserve user work and
require tested migration approval before applying any new database migration.

## Verified platform references; recheck before implementation

- https://developers.cloudflare.com/durable-objects/best-practices/websockets/
- https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/
- https://developers.cloudflare.com/agents/runtime/execution/durable-execution/

Durable Objects can run model loops, but eviction loses active JS and upstream
model connections. We are choosing a live-delivery seam first, not assuming that
moving the loop automatically supplies crash recovery or exactly-once tools.
