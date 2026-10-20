import { AuthSnapshotId, WorkspaceId } from "../../domain/ids";
import {
	accountCleanupTargets,
	deleteAccountRecords,
} from "../adapters/account-deletion";
import { deleteAnalyticsPerson } from "../adapters/analytics-deletion";
import {
	checkpointStorageConfigured,
	removeChatObjects,
} from "../adapters/checkpoints/storage";
import { memoryRepo, memoryRepoName } from "../adapters/memory-repos";
import { purgeConversationState } from "../adapters/realtime-delivery";
import { cancelServerTurn } from "./cancel-server-turn";
import { removeUserPullRequestEvidence } from "./pr-evidence-cleanup";
import type { WorkspaceMachines } from "./workspace-machines";

/** Calls in flight at once: keeps a heavy account's deletion fast without a burst. */
export const CLEANUP_CONCURRENCY = 6;

/**
 * Runs `work` over `items` with at most `limit` calls in flight. The first
 * failure stops new calls from starting and is rethrown once in-flight ones end.
 */
export async function eachLimited<T>(
	items: readonly T[],
	limit: number,
	work: (item: T) => Promise<void>,
) {
	let next = 0;
	let failure: { error: unknown } | null = null;
	const worker = async () => {
		while (!failure && next < items.length) {
			const item = items[next++];
			await work(item).catch((error) => {
				failure ??= { error };
			});
		}
	};
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, worker),
	);
	if (failure) throw (failure as { error: unknown }).error;
}

/**
 * Deletes an account and what it owns: its chats' stored checkpoints and
 * attachments, then every database row (they cascade from auth_user, sessions
 * included, which signs it out everywhere), then its VMs, private snapshots,
 * memory repo and analytics person. Its running turns are cancelled first.
 *
 * The steps that can fail and be retried come first: a storage or database
 * failure leaves the account intact with its VMs and snapshots, so retrying
 * finds them again. Provider resources are destroyed only once the rows are
 * gone, so a live account never points at a destroyed snapshot; a failure
 * there is logged and left to expire (VMs by their idle timeout).
 */
export async function deleteAccount(
	machines: Pick<WorkspaceMachines, "destroy" | "destroySnapshot">,
	userId: string,
) {
	const targets = await accountCleanupTargets(userId);
	// Running turns stop first, so none writes a checkpoint, chat state or a
	// row while the account is being removed.
	await eachLimited(targets.sessionIds, CLEANUP_CONCURRENCY, (sessionId) =>
		cancelServerTurn(userId, sessionId).catch(() => {
			console.warn("A running turn could not be cancelled before deletion.");
		}),
	);
	if (checkpointStorageConfigured())
		await eachLimited(targets.sessionIds, CLEANUP_CONCURRENCY, (sessionId) =>
			removeChatObjects(userId, sessionId),
		).catch(() => {
			throw new Response(
				"Your account was not deleted because its saved chat files could not be removed. Try again.",
				{ status: 503 },
			);
		});
	await eachLimited(targets.sessionIds, CLEANUP_CONCURRENCY, (sessionId) =>
		purgeConversationState(userId, sessionId),
	).catch(() => {
		throw new Response(
			"Your account was not deleted because its chats' state could not be removed. Try again.",
			{ status: 503 },
		);
	});
	// Pull request evidence media, before the rows that point at it go.
	await removeUserPullRequestEvidence(userId).catch(() => {
		throw new Response(
			"Your account was not deleted because its pull request evidence could not be removed. Try again.",
			{ status: 503 },
		);
	});
	await deleteAccountRecords(userId);
	const sharedToolsSnapshot = process.env.YTIMESY_TOOLS_SNAPSHOT_ID?.trim();
	const leftovers: string[] = [];
	await eachLimited(targets.vmIds, CLEANUP_CONCURRENCY, (vmId) =>
		machines.destroy(WorkspaceId(vmId)).catch(() => {
			leftovers.push(`vm:${vmId}`);
		}),
	);
	await eachLimited(
		targets.snapshotIds.filter((id) => id !== sharedToolsSnapshot),
		CLEANUP_CONCURRENCY,
		(snapshotId) =>
			machines.destroySnapshot(AuthSnapshotId(snapshotId)).catch(() => {
				leftovers.push(`snapshot:${snapshotId}`);
			}),
	);
	// The user's memory (Agent Memory Repo) lives in Cloudflare Artifacts.
	for (const name of new Set(
		[memoryRepoName(userId), targets.memoryRepo].filter(
			(value): value is string => Boolean(value),
		),
	))
		await memoryRepo(name)
			?.destroy()
			.catch(() => {
				leftovers.push(`memory:${name}`);
			});
	// Product analytics: the person, their events and session recordings.
	await deleteAnalyticsPerson(userId)
		.then((deleted) => {
			if (!deleted) leftovers.push("analytics:unconfigured");
		})
		.catch(() => {
			leftovers.push("analytics:person");
		});
	if (leftovers.length)
		console.warn("Account deletion left provider resources to expire.", {
			userId,
			leftovers,
		});
}
