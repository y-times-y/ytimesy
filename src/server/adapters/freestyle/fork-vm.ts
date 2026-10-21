import type { Vm } from "freestyle";
import { WorkspaceProvisionError } from "#/server/services/errors";

/** The snapshot outlives a failed cleanup by at most this long (the decision's backstop). */
export const FORK_SNAPSHOT_AUTO_DELETE_SECONDS = 3600;

/**
 * Forks a running VM for a writer subagent: a snapshot of its memory and
 * disk (uncommitted work and running processes included), a new VM booted
 * from it, then the snapshot deleted.
 *
 * Unlike every other snapshot path (snapshotEnvironment, the runtime's
 * snapshot, retention) this one does NOT call scrubAgentSecrets: that
 * wrapper deletes the secrets directory on the VM it snapshots, which here
 * is the parent's live VM. The fork carries the parent's secrets (same
 * user, same task), so the snapshot must stay private: a public one is
 * deleted and the fork refused, and it is never reused as a template.
 *
 * The parent's memory repo write token is not the fork's: `scrubFork`
 * removes it from the booted fork before anyone uses it, and a fork it
 * cannot prove clean is deleted and refused.
 */
export async function forkRunningVm(input: {
	readonly source: Pick<Vm, "snapshot">;
	readonly sourceVmId: string;
	/** Boots a VM from the snapshot and waits until it runs. */
	readonly boot: (snapshotId: string) => Promise<string>;
	readonly deleteSnapshot: (snapshotId: string) => Promise<unknown>;
	/** Removes the parent's memory token from the fork; throws when it cannot. */
	readonly scrubFork: (vmId: string) => Promise<void>;
	readonly deleteVm: (vmId: string) => Promise<unknown>;
	readonly now?: () => number;
}): Promise<{ vmId: string; snapshotId: string; forkMs: number }> {
	const now = input.now ?? Date.now;
	const started = now();
	const created = await input.source.snapshot({
		displayName: "ytimesy subagent fork",
		autoDeleteSeconds: FORK_SNAPSHOT_AUTO_DELETE_SECONDS,
	});
	if (created.snapshot.public) {
		await input.deleteSnapshot(created.snapshotId).catch(() => undefined);
		throw new WorkspaceProvisionError({
			operation: "snapshot",
			message:
				"Freestyle returned a public snapshot of a live workspace; deleted it and refused the fork",
			providerWorkspaceId: input.sourceVmId,
		});
	}
	try {
		const vmId = await input.boot(created.snapshotId);
		try {
			await input.scrubFork(vmId);
		} catch (cause) {
			await input.deleteVm(vmId).catch(() => {
				console.warn("A fork that kept the memory token could not be deleted.");
			});
			throw new WorkspaceProvisionError({
				operation: "snapshot",
				message: `The fork's memory token could not be removed; deleted it and refused the fork: ${cause instanceof Error ? cause.message : "unknown"}`,
				providerWorkspaceId: input.sourceVmId,
			});
		}
		return { vmId, snapshotId: created.snapshotId, forkMs: now() - started };
	} finally {
		// Gone once the VM runs (or failed to): never a reusable template.
		await input.deleteSnapshot(created.snapshotId).catch(() => {
			console.warn(
				"Fork snapshot deletion failed; its auto-delete removes it within the hour.",
			);
		});
	}
}
