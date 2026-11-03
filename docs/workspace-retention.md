# Workspace retention

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

- [Cursor security and networking](https://cursor.com/docs/cloud-agent/security-network)
- [Cursor cloud-agent security](https://cursor.com/docs/cloud-agent/security)
- [Cursor Builds](https://cursor.com/docs/cloud-agent/builds)
- [Freestyle snapshot lifecycle](https://www.freestyle.sh/docs/vms/base-snapshots)
- [Freestyle VM lifecycle](https://www.freestyle.sh/docs/vms/lifecycle)
- [Freestyle pricing and limits](https://www.freestyle.sh/docs/vms/pricing-and-limits)

Provider behavior was researched on 2026-10-03; recheck effective account limits
at deployment rather than treating documentation as an account-level guarantee.
