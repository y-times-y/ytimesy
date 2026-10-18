import { appOpenPullNumbers } from "../adapters/github/pr-evidence-body";
import {
	deleteEvidenceRows,
	type EvidenceScope,
	evidenceOfClosedPulls,
	evidenceOfOwner,
	evidenceRepositories,
	expiredEvidence,
	failStaleCaptures,
} from "../adapters/pr-evidence-records";
import {
	type EvidenceStore,
	evidenceCapturePrefix,
	evidenceProjectPrefix,
	evidenceUserPrefix,
	r2EvidenceStore,
} from "../adapters/pr-evidence-store";

/**
 * Removing pull request evidence: media first (private R2), then rows, so a
 * failure leaves a row the next sweep retries rather than orphaned media.
 * Nothing in the user's repositories is touched; evidence never lives there.
 */
type CleanupDependencies = {
	store?: EvidenceStore;
	rows?: {
		ofOwner: typeof evidenceOfOwner;
		expired: typeof expiredEvidence;
		repositories: typeof evidenceRepositories;
		ofClosedPulls: typeof evidenceOfClosedPulls;
		failStale: typeof failStaleCaptures;
		remove: typeof deleteEvidenceRows;
	};
	openPulls?: typeof appOpenPullNumbers;
	now?: Date;
};

const defaultRows = {
	ofOwner: evidenceOfOwner,
	expired: expiredEvidence,
	repositories: evidenceRepositories,
	ofClosedPulls: evidenceOfClosedPulls,
	failStale: failStaleCaptures,
	remove: deleteEvidenceRows,
};

async function removeCaptures(
	rows: readonly EvidenceScope[],
	store: EvidenceStore,
	remove: typeof deleteEvidenceRows,
) {
	const removed: string[] = [];
	for (const row of rows) {
		try {
			await store.removePrefix(evidenceCapturePrefix(row, row.id));
			removed.push(row.id);
		} catch {
			console.warn("Pull request evidence media was left for the next sweep.");
		}
	}
	await remove(removed);
	return removed.length;
}

/** Project deletion: every capture of the project, before its rows cascade. */
export async function removeProjectPullRequestEvidence(
	userId: string,
	projectId: string,
	deps: CleanupDependencies = {},
) {
	const store = deps.store ?? r2EvidenceStore;
	const rows = deps.rows ?? defaultRows;
	await store.removePrefix(evidenceProjectPrefix(userId, projectId));
	const owned = await rows.ofOwner(userId, projectId);
	await rows.remove(owned.map((row) => row.id));
	return owned.length;
}

/** Account deletion and eval-user release: everything the user has stored. */
export async function removeUserPullRequestEvidence(
	userId: string,
	deps: CleanupDependencies = {},
) {
	const store = deps.store ?? r2EvidenceStore;
	const rows = deps.rows ?? defaultRows;
	await store.removePrefix(evidenceUserPrefix(userId));
	const owned = await rows.ofOwner(userId);
	await rows.remove(owned.map((row) => row.id));
	return owned.length;
}

/**
 * The periodic expiry sweep (maintenance action evidence-expiry): removes
 * captures past their 30-day expiry and captures of pull requests that are
 * no longer open, and reports captures whose job died as failed. Returns how
 * many captures were removed.
 */
export async function expirePullRequestEvidence(
	deps: CleanupDependencies = {},
) {
	const store = deps.store ?? r2EvidenceStore;
	const rows = deps.rows ?? defaultRows;
	const now = deps.now ?? new Date();
	await rows.failStale(now);
	let removed = await removeCaptures(
		await rows.expired(now),
		store,
		rows.remove,
	);
	for (const repository of await rows.repositories()) {
		let open: Set<number>;
		try {
			open = await (deps.openPulls ?? appOpenPullNumbers)(
				repository.installationId,
				repository.fullName,
			);
		} catch {
			// Unreachable repositories keep their evidence until it expires.
			console.warn("Pull request evidence expiry skipped a repository.", {
				repository: repository.fullName,
			});
			continue;
		}
		removed += await removeCaptures(
			await rows.ofClosedPulls(repository, open),
			store,
			rows.remove,
		);
	}
	return removed;
}
