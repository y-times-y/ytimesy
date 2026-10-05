# Durable model steps

Cloudflare Workflows coordinates one model/tool step at a time. PostgreSQL retains
conversation history, tool receipts, usage, admission, and step receipts. The
existing Durable Object retains the live lease, cancellation, and progress stream.
Provider SDK inference and tools still run on the trusted Node executor; repository
commands run in task Freestyle VMs. This is not a replacement of the entire Node
worker or an elimination of its compute cost.

## Direct edge executor migration (not enabled)

`wrangler.edge-executor.jsonc` and `src/server/edge/executor.ts` stage the same
owner-scoped execution handler for Cloudflare Workers. The build embeds trusted
Python guest-program assets rather than reading a developer filesystem at
runtime. Database pools are invocation-scoped; an in-flight heartbeat is awaited
before its pool closes. Codex credential refresh now uses the native HTTPS OAuth
grant while retaining the existing per-owner PostgreSQL refresh lock.

This entry point is a prototype, **not deployable as a complete replacement yet**.
There is no Hyperdrive binding or deployed edge executor. Linux-only trusted Git
brokerage and Rigkit/Bun need an on-demand service. Custom API endpoints must keep
socket-time DNS/SSRF defenses rather than silently switching to unpinned fetch.
The queue dispatcher, peer/event delivery, checkpoint and retention maintenance
must also migrate before the existing Node worker can stop. Request-owned queue,
analytics and progress-delivery resources need live runtime verification.

Do not change the active Workflow executor URL or stop the existing worker until
real inference, repository edits, environment preparation, parallel children,
peer delivery, cancellation, restart and checkpoint recovery pass without it.
Enabling Cloudflare Containers for the Linux-only operations needs an authorized
ongoing spending cap. No new container or persistent compute has been deployed.

Local checks on 2026-10-04: 226 test files passed (1,087 tests, 3 skipped),
typecheck, lint and the production build passed. The staged bundle started in
Wrangler's local Cloudflare runtime after providing Node built-in compatibility
for bundled CommonJS dependencies. An unknown route returned 404 and an unsigned
model-step request returned 401. These checks do not prove a signed model step,
Hyperdrive connectivity or Linux jobs. A separate live check refreshed the sole
connected development Codex account through HTTPS and persisted its credentials
through the existing row-locked encrypted vault, without launching a CLI. It did
not run model inference and does not prove the complete edge execution path.

## Safety and recovery

The signed executor request contains only turn ID, lease ID, and step index.
Credentials, prompts, and tool output do not enter Workflow state. A server-only
PostgreSQL receipt is claimed before inference. Completed receipts return cached
outcomes; an unfinished receipt fails closed instead of repeating uncertain paid
inference or edits. Workflow step retries are disabled. Provider tool IDs are
namespaced per step so repeated IDs cannot reuse another step's tool receipt.

The turn has a shared 30-minute deadline and 30 model steps. Step 31 settles the
limit without inference. Cancellation between steps settles the turn without
inference. Cancellation during a step uses the existing abort/command-stop path.
Lease expiry or a lost executor does not promise automatic recovery of an
uncertain operation; inspection is required. Cloudflare availability does not
remove the executor or database dependency.

## Development rollout

Run `scripts/deploy-model-workflows-development.ts --apply` with the existing
development environment to stage the separate Worker and executor. Add `--enable`
to enable normal queued dispatch after verification. Deployment checks the linked
development database, rejects active turns, and reuses the owned worker VM.
It does not create a new persistent VM. Rollback uses the same staged command
without `--enable`; the old full-loop implementation remains available.

`scripts/prove-model-workflows-development.ts --run --queued` verifies ordinary
queue admission, a real subscription tool call, final response, step receipts,
usage, and context. The proof creates a dedicated chat and does not create a task
VM or edit a repository. Without `--queued`, it tests direct staged admission.

## Evidence and boundaries

On 2026-10-04, a real Codex subscription `gpt-6-luna` run completed in two steps
through the staged Workflow: `list_peers`, then `workflow-proof-complete`. It saved
4,552 input and 44 output tokens and a 2,319 / 272,000 context reading. No task VM
was created. Restarting the completed Workflow reused the receipts: timestamps
and token totals were unchanged. This proves completed-step replay, not recovery
after an unknown side effect. Cancellation, step fencing, and API-provider paths
also have automated tests. No production rollout or 10,000-user capacity test is
implied by these checks.

Normal queued dispatch was subsequently enabled in development and verified with
turn `929efb79-8b96-4b3e-b0d8-4c5a4e1ac4db`: two completed receipts, 4,552 input
and 40 output tokens, and context 2,315 / 272,000. Cloudflare reported the instance
completed. The local browser displayed the final response, expandable worked/tool
groups, and a context popover showing 2.3K / 272K tokens used.
