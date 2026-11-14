import { useCallback, useSyncExternalStore } from "react";
import type { CanvasNote } from "#/domain/canvas-annotation";

/**
 * The notes pinned on each canvas revision, by its item id (unique across
 * chats), kept for the page's life: switching the right panel to another
 * view or another canvas and back keeps them until they are sent.
 */
const notesByCanvas = new Map<string, readonly CanvasNote[]>();
const listeners = new Set<() => void>();
const NONE: readonly CanvasNote[] = [];

function subscribe(listener: () => void) {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

export function useCanvasNotes(canvasId: string) {
	const notes = useSyncExternalStore(
		subscribe,
		() => notesByCanvas.get(canvasId) ?? NONE,
		() => NONE,
	);
	const update = useCallback(
		(change: (notes: readonly CanvasNote[]) => readonly CanvasNote[]) => {
			const next = change(notesByCanvas.get(canvasId) ?? NONE);
			if (next.length) notesByCanvas.set(canvasId, next);
			else notesByCanvas.delete(canvasId);
			for (const listener of listeners) listener();
		},
		[canvasId],
	);
	return [notes, update] as const;
}
