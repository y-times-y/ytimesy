import { AuthSnapshotId, WorkspaceId } from "../../domain/ids";
import {
	accountCleanupTargets,
	deleteAccountRecords,
} from "../adapters/account-deletion";
import {
	checkpointStorageConfigured,
	removeChatObjects,
} from "../adapters/checkpoints/storage";
import type { WorkspaceMachines } from "./workspace-machines";

/**
 * Deletes an account and what it owns: its VMs and private snapshots, its
 * chats' stored checkpoints and attachments, then every database row (they
 * cascade from auth_user, sessions included, which signs it out everywhere).
 *
 * VM and snapshot failures do not stop deletion: VMs are reclaimed by their
 * idle timeout. A storage failure does stop it, before any row is deleted, so
 * retrying can still find and delete the files.
 */
export async function deleteAccount(
	machines: Pick<WorkspaceMachines, "destroy" | "destroySnapshot">,
	userId: string,
) {
	const targets = await accountCleanupTargets(userId);
	const sharedToolsSnapshot = process.env.YTIMESY_TOOLS_SNAPSHOT_ID?.trim();
	let leftovers = 0;
	for (const vmId of targets.vmIds)
		await machines.destroy(WorkspaceId(vmId)).catch(() => {
			leftovers++;
		});
	for (const snapshotId of targets.snapshotIds) {
		if (snapshotId === sharedToolsSnapshot) continue;
		await machines.destroySnapshot(AuthSnapshotId(snapshotId)).catch(() => {
			leftovers++;
		});
	}
	if (leftovers)
		console.warn("Account deletion left provider resources to expire.", {
			leftovers,
		});
	if (checkpointStorageConfigured())
		for (const sessionId of targets.sessionIds)
			await removeChatObjects(userId, sessionId).catch(() => {
				throw new Response(
					"Your account was not deleted because its saved chat files could not be removed. Try again.",
					{ status: 503 },
				);
			});
	await deleteAccountRecords(userId);
}
