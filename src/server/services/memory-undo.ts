import {
	type SavedMemoryLine,
	withoutMemoryLine,
} from "#/domain/memory-marker";
import type { MemoryRepo } from "../adapters/memory-repos";

/** Removes one saved entry with a commit; `removed: false` when memory no longer holds it. */
export async function removeMemoryLine(
	repo: MemoryRepo,
	line: SavedMemoryLine,
): Promise<{ removed: boolean }> {
	let snapshot = await repo.snapshot();
	for (let attempt = 0; attempt < 2; attempt++) {
		const change = withoutMemoryLine(snapshot.files, line);
		if (!change) return { removed: false };
		const outcome = await repo.commit(
			snapshot,
			[change],
			`Undo memory: ${line.text.length > 72 ? `${line.text.slice(0, 71)}…` : line.text}`,
		);
		if (outcome.ok) return { removed: true };
		snapshot = await repo.snapshot();
	}
	throw new Error("Memory changed while undoing; try again.");
}
