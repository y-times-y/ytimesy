import { DREAM_COMMIT_PREFIX } from "#/domain/memory-dream-schedule";
import { applyMemoryEdit, type MemoryEdit } from "#/domain/memory-edit";
import { memoryChangeSummary } from "#/domain/memory-overview";
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
): Promise<{ ok: true } | { ok: false; error: string }> {
	let snapshot = await repo.snapshot();
	for (let attempt = 0; attempt < 2; attempt++) {
		const result = applyMemoryEdit(snapshot.files, edit, today);
		if (!result.ok) return result;
		const outcome = await repo.commit(snapshot, result.changes, result.message);
		if (outcome.ok) return { ok: true };
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
