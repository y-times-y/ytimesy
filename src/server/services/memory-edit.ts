import { DREAM_COMMIT_PREFIX } from "#/domain/memory-dream-schedule";
import {
	applyMemoryEdit,
	type MemoryEdit,
	type MemoryLineRef,
} from "#/domain/memory-edit";
import type { DreamInput } from "#/domain/memory-lanes";
import { memoryChangeSummary, memoryRows } from "#/domain/memory-overview";
import { memoryTokens } from "#/domain/memory-ranking";
import type { MemoryRepo } from "../adapters/memory-repos";

/**
 * A manual edit from the Memory view as one commit. A concurrent edit (a
 * chat's save, a dream) is re-read once and the edit applied again to the
 * new state; a line that is gone by then is reported, not recreated.
 */
export async function commitMemoryEdit(
	repo: MemoryRepo,
	edit: MemoryEdit,
	today: string,
): Promise<{ ok: true; added?: MemoryLineRef } | { ok: false; error: string }> {
	let snapshot = await repo.snapshot();
	for (let attempt = 0; attempt < 2; attempt++) {
		const result = applyMemoryEdit(snapshot.files, edit, today);
		if (!result.ok) return result;
		const outcome = await repo.commit(snapshot, result.changes, result.message);
		if (outcome.ok)
			return result.added ? { ok: true, added: result.added } : { ok: true };
		snapshot = outcome.current;
	}
	return { ok: false, error: "Memory changed while saving; try again." };
}

/** The newest dream commit among the last `depth` commits, and what it changed. */
export async function lastDreamChange(
	repo: MemoryRepo,
	today: string,
	depth = 60,
) {
	if (!repo.log) return null;
	const commits = await repo.log(depth);
	const dream = commits.find((commit) =>
		commit.message.startsWith(DREAM_COMMIT_PREFIX),
	);
	if (!dream) return null;
	const [after, before] = await Promise.all([
		repo.snapshotAt(dream.hash),
		dream.parent
			? repo.snapshotAt(dream.parent)
			: Promise.resolve({ head: null, files: {} }),
	]);
	return {
		at: new Date(dream.committedAt).toISOString(),
		message: dream.message.slice(DREAM_COMMIT_PREFIX.length).trim(),
		summary: memoryChangeSummary(
			before.files,
			after.files,
			today,
			memoryTokens,
		),
	};
}

/**
 * The newest dream commits (up to `limit` among the last `depth` commits),
 * each with the lines it merged: the merged lines' own dates, scopes and
 * kinds from the commit's parent, so the lanes can draw them converging.
 */
export async function dreamHistory(
	repo: MemoryRepo,
	today: string,
	options: { depth?: number; limit?: number } = {},
): Promise<DreamInput[]> {
	if (!repo.log) return [];
	const commits = (await repo.log(options.depth ?? 80))
		.filter((commit) => commit.message.startsWith(DREAM_COMMIT_PREFIX))
		.slice(0, options.limit ?? 8);
	return Promise.all(
		commits.map(async (commit) => {
			const [after, before] = await Promise.all([
				repo.snapshotAt(commit.hash),
				commit.parent
					? repo.snapshotAt(commit.parent)
					: Promise.resolve({ head: null, files: {} }),
			]);
			const summary = memoryChangeSummary(
				before.files,
				after.files,
				today,
				memoryTokens,
			);
			const old = memoryRows(before.files, today);
			return {
				at: new Date(commit.committedAt).toISOString(),
				message: commit.message.slice(DREAM_COMMIT_PREFIX.length).trim(),
				merges: summary.merged.map((merge) => ({
					into: merge.into,
					from: merge.from.map((text) => {
						const row = old.find((entry) => entry.text === text);
						return {
							text,
							...(row?.added ? { added: row.added } : {}),
							...(row?.project ? { project: row.project } : {}),
							...(row ? { kind: row.kind } : {}),
						};
					}),
				})),
			};
		}),
	);
}
