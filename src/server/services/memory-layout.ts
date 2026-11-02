import {
	MEMORY_LAYOUT_COMMIT,
	type MemoryProject,
	memoryLayoutChanges,
	needsMemoryLayout,
} from "#/domain/memory-layout";
import { withMemoryChanges } from "#/domain/memory-repo";
import type { MemoryRepo, MemorySnapshot } from "../adapters/memory-repos";

/**
 * Moves a memory repo into the per-project layout (memory-layout.ts) on its
 * first access after the change, as one "Reorganize memory by project"
 * commit, so `git revert` of that commit restores the old layout exactly.
 * Never deletes a line; a repo already in the layout is left alone (one
 * marker check, no write). A concurrent write is re-read once. Returns the
 * snapshot to work from; a failure leaves the repo as it was and the
 * read side reads legacy files by their `project:` keys meanwhile.
 */
export async function ensureMemoryLayout(
	repo: MemoryRepo,
	projects: () => Promise<readonly MemoryProject[]>,
	snapshot?: MemorySnapshot,
): Promise<MemorySnapshot> {
	let current = snapshot ?? (await repo.snapshot());
	for (let attempt = 0; attempt < 2; attempt++) {
		// A repo nobody wrote yet has nothing to move; its first write starts it.
		if (!current.head || !needsMemoryLayout(current.files)) return current;
		const changes = memoryLayoutChanges(current.files, await projects());
		if (!changes) return current;
		const outcome = await repo.commit(current, changes, MEMORY_LAYOUT_COMMIT);
		if (outcome.ok)
			return {
				head: outcome.hash,
				files: withMemoryChanges(current.files, changes),
			};
		current = await repo.snapshot();
	}
	return current;
}

/** ensureMemoryLayout that never fails: on any error, the snapshot as it was. */
export async function memoryInLayout(
	repo: MemoryRepo,
	projects: () => Promise<readonly MemoryProject[]>,
	snapshot?: MemorySnapshot,
): Promise<MemorySnapshot> {
	const base = snapshot ?? (await repo.snapshot());
	try {
		return await ensureMemoryLayout(repo, projects, base);
	} catch (error) {
		console.warn("Memory could not be moved to the project layout.", {
			error: error instanceof Error ? error.name : "unknown",
		});
		return base;
	}
}
