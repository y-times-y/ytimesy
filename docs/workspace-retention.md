# Workspace retention

## Decision 2026-11-11: pause and auto-delete replace recycling

Recycling (capture an idle chat VM to a snapshot after an hour, delete the VM,
restore a new VM from the snapshot later) is stopped. Idle chat VMs stay paused
and Freestyle deletes them after 90 days without running
(`PRODUCT_AUTO_DELETE_SECONDS` in `src/server/adapters/freestyle/product-vm.ts`).
Do not bring recycling back to save money: it saves none.

Why, all checked on the live Freestyle account (Hobby plan) on 2026-11-11:

- **Same storage cost.** Freestyle bills a paused VM for its allocated disk
  and saved memory, and a snapshot for its allocated disk and captured memory,
  at the same rate ($0.000086/GiB-hour). Recycling moved the bytes; it did not
  shrink them. It added compute (the capture run, the in-guest digests and a
  verification VM) on every recycle.
- **Same state kept.** Both a pause and a snapshot keep memory and disk. A
  marker written to `/dev/shm` survived a resume and a snapshot boot alike.
- **Pause returns faster.** Resuming the same paused VM was ready in 0.25,
  0.29 and 1.2 s; a new VM from a snapshot of it in 3.9, 1.1 and 0.9 s
  (2 vCPU, 4 GiB, 16 GiB, ready = the guest answers a command). A restore
  also rebinds the chat to a new VM and re-delivers the scrubbed secrets, which
  a resume does not. These are small samples; the big slowness of returning to
  a chat, if any, lives in ytimesy's own resume steps, not the provider.
- **The VM-level window now exists.** This doc's original reason for
  application tracking was the *snapshot* `autoDeleteSeconds`, which counts
  from the last VM created from it. Freestyle SDK 0.2.13 also has a VM-level
  `autoDeleteSeconds`: "Delete the VM once it has gone this many seconds
  without running. Every start resets the clock." A 90-day value was accepted
  on create and on update on this account (no plan cap).
- **VM slots are not the constraint.** 53 of 200 VMs were in use.

What runs now:

- New product VMs are created with the 90-day window. Older ones get it on
  their next resume (`productLifecycleUpdate`, applied in `resumeProductVm`
  and `FreestyleWorkspaceRuntime.resume`), the moment they run, so it never
  lands on a VM that is already long idle.
- The scheduled step is `settleRetainedWorkspaces`: it only expires retained
  snapshots and returns interrupted captures to active. Nothing captures or
  deletes idle VMs any more.
- Chats already recycled still restore from their snapshot
  (`restoreRetainedWorkspace`) until it expires (90 days after capture), so
  `YTIMESY_WORKSPACE_RETENTION` stays `true` for now.

Left to do: once the last retained snapshot expires (no `workspace_retention`
row left in phase `retained`), delete `recycleWorkspace`, the restore path,
the retention touch in admission and the `workspace_retention` table. VMs that
are never resumed again do not get the window from the resume path; give them
one with a one-off update, or delete the ones nobody will return to.

The sections below describe recycling as it was built.

## Original design (2026-10-03)

Development rollout enabled on 2026-10-03; production is unchanged.

## User behavior

- Pause idle workspaces without interrupting active work or interactive access.
- Preserve a private full-disk snapshot before recycling compute. Include ignored
  files and local workspace state, not only Git-tracked files.
- Retain recoverable workspace state for a rolling 90 days of inactivity; actual
  session use and resume renew the window. Reading chat history does not boot a VM.
- Keep conversation records independently of VM or snapshot expiry. Workspace
  expiry must be visible and must not silently erase conversation history.
- Store managed credentials separately. Snapshots containing user-created secrets
  remain private and accessible only through owner-authorized recovery.

## Reuse and safety gates

Use Freestyle's existing snapshot/create APIs and the existing session recovery
flow. Keep encrypted repository checkpoints as an additional recovery layer, not
as proof that the complete disk can be recovered.

Recycling requires all of these conditions:

1. No running turn or interactive workspace access, enforced by a lifecycle fence
   shared with every start/resume path. Rechecking `paused` alone has a race.
2. A materialized snapshot whose returned metadata confirms it is private and
   belongs to the expected source VM.
3. Successful isolated restore verification. A verification copy must deny
   network access so snapshotted background processes cannot repeat external
   effects; dispose of only that verification copy afterward.
4. A durably recorded owner/session/source binding and effective retention window.
   If the provider applies a shorter plan cap, do not promise 90-day recovery.
5. A recovery path that restores this snapshot before falling back to a project
   template and repository-only checkpoint.

If any gate fails, retain the source VM and surface the actionable failure.
Never delete first and attempt to establish recoverability afterward.

## Provider-specific distinction

In the installed Freestyle SDK, `autoDeleteSeconds` is inactivity measured since
a VM was last **created from the snapshot**. Resuming the original VM does not
renew that timer. `ttlSeconds` is an absolute age limit and therefore cannot
implement rolling inactivity. Use application activity tracking and reconcile
provider retention rather than treating either field as the complete policy.

## Verification and rollout status

The development worker now retires enrolled session VMs after an hour of inactivity,
only after verifying a private full-state snapshot in a deny-network copy. Recovery
restores that snapshot with a funded native runtime cap and atomically rebinds the
chat. Shared read-only children recover the parent's binding. Expiry removes only
the verified application-owned recovery artifact, retaining conversation records.
Failed captures back off; interrupted captures are recoverable under the per-VM
fence. Unsupported cases keep the source machine.

The fixed deployment cutover protects every pre-existing machine. Enrollment
requires both retention and compute admission enabled and a valid cutover timestamp.
Never advance the cutover on restart. Templates, workspace desktops, operator VMs
and older sessions are outside automatic retirement; this is not fleet-wide cleanup.

Verification hashes each project root inside the guest with one command (as
root): a sorted manifest of type, mode, owner, group, file size and path plus
every file's sha256, ignored files included, reduced to one digest. It runs on the
source and on the deny-network copy restored from the snapshot, and the two must
match. Bounds: 250,000 entries, 4 GiB of content and 20 seconds per digest.
Symlinks (such as `node_modules/.bin`) are covered by path, owner and target
text from `readlink`, never followed. A symlinked project root is refused,
since its digest would cover only the link. Fifos, sockets and devices fail
closed. A process still writing in the project makes the two digests differ;
that defers (category `mismatch`) and keeps the VM. Every deferral is logged at
info with a short `category`. A 7,990-entry repository (53 MB) hashes in
under a second; the whole recycle takes about 7 seconds. The full-state provider
snapshot captures more than the project roots independently checked.

The source is fenced at its used runtime, so exec is refused there. Recycling
opens a funded 45-second run window to scrub secrets and hash the tree, pauses
the source and re-fences it before the snapshot. Network activity stamped after
the fence is that window's own resume; earlier activity still defers.

The previous check walked the tree with Freestyle's file API, one request per
stat and per read. On a paused VM that API reads the disk image, without writes
still in the guest page cache, and it could not finish a real repository inside
its budget.

Evidence: 50 targeted tests passed across recovery, allowance, fleet-cost and
session-machine suites; typecheck and production build passed. Two disposable live
proofs verified ignored text, binary data and permissions. The application proof
also deleted its own source, funded a replacement from the retained image and
rebound the chat. Its idle clock was simulated; the scheduler was not observed
for an hour. All proof sessions and their known recovery resources were removed.
No pre-existing user VM was deleted. Multi-replica load and genuine-admin browser
verification remain separate gates.

## Primary references

- [Freestyle snapshot lifecycle](https://www.freestyle.sh/docs/vms/base-snapshots)
- [Freestyle VM lifecycle](https://www.freestyle.sh/docs/vms/lifecycle)
- [Freestyle pricing and limits](https://www.freestyle.sh/docs/vms/pricing-and-limits)

Provider behavior was researched on 2026-10-03; recheck effective account limits
at deployment rather than treating documentation as an account-level guarantee.
