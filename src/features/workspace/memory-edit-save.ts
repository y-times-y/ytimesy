import type { QueryClient } from "@tanstack/react-query";
import {
	applyMemoryEdit,
	type MemoryEdit,
	type MemoryEditResult,
} from "#/domain/memory-edit";
import { memoryToday } from "#/domain/memory-repo";
import { cacheWrite, optimisticMutation } from "#/lib/optimistic-mutation";
import type { MemoryOverview } from "./memory.fn";

const MEMORY_KEY = ["memory"];
const SCOPE = "memory";

type SavedEdit = { ok: true; added?: unknown } | { ok: false; error: string };

/** The files after `edit`, as the server will commit them; unchanged when it cannot apply. */
export function memoryAfterEdit(
	memory: MemoryOverview,
	edit: MemoryEdit,
	today: string,
): MemoryOverview {
	const files = Object.fromEntries(
		memory.files.map((file) => [file.path, file.content]),
	);
	const result: MemoryEditResult = applyMemoryEdit(files, edit, today);
	if (!result.ok) return memory;
	for (const change of result.changes)
		if (change.content === null) delete files[change.path];
		else files[change.path] = change.content;
	return {
		...memory,
		files: Object.entries(files)
			.map(([path, content]) => ({ path, content }))
			.sort((a, b) => a.path.localeCompare(b.path)),
	};
}

/**
 * Editing, moving, pinning or deleting a line shows at once. A new line waits
 * for the server: the composer keeps the typed text until it is stored.
 * An edit the server refuses (the line changed meanwhile) throws, so it rolls
 * back like a failed request.
 */
export function memoryEditSave<TResult extends SavedEdit>(
	queryClient: QueryClient,
	edit: (input: { data: MemoryEdit }) => Promise<TResult>,
) {
	return {
		mutationFn: async (data: MemoryEdit) => {
			const result = await edit({ data });
			if (!result.ok && data.op !== "add") throw new Error(result.error);
			return result;
		},
		...optimisticMutation<TResult, MemoryEdit>({
			queryClient,
			scope: SCOPE,
			writes: (data) =>
				data.op === "add"
					? []
					: [
							cacheWrite<MemoryOverview>(MEMORY_KEY, (memory) =>
								memoryAfterEdit(memory, data, memoryToday()),
							),
						],
			invalidate: [MEMORY_KEY],
		}),
	};
}

/** A text edit that failed: which line's editor to reopen, holding what was typed. */
export function editorToReopen(
	edit: MemoryEdit,
): { key: string; text: string } | null {
	return edit.op === "update" && edit.text !== undefined
		? { key: `${edit.ref.path}:${edit.ref.line}`, text: edit.text }
		: null;
}

/** "Delete all memory" empties the list at once. */
export function memoryClear(
	queryClient: QueryClient,
	clear: (input: { data: Record<string, never> }) => Promise<unknown>,
) {
	return {
		mutationFn: () => clear({ data: {} }),
		...optimisticMutation<unknown, void>({
			queryClient,
			scope: SCOPE,
			writes: () => [
				cacheWrite<MemoryOverview>(MEMORY_KEY, (memory) => ({
					...memory,
					files: [],
				})),
			],
		}),
	};
}
