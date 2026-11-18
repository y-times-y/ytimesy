import { useEffect, useState } from "react";
import type { CanvasItem, DynamicToolCallItem } from "#/domain/session-item";
import { getSessionItemDetail } from "./codex-session.fn";

/** An item a page read cut (pageItemSql): its chat holds the whole. */
type CutItem = (DynamicToolCallItem | CanvasItem) & {
	readonly detailSession?: string;
};

export function isCut(item: CutItem) {
	return (
		Boolean(item.detailSession) &&
		(("truncated" in item && item.truncated === true) ||
			("htmlOmitted" in item && item.htmlOmitted === true))
	);
}

/**
 * Reads whole items once each: concurrent readers of one item (a card and
 * the canvas panel) share one read, and a finished item is kept, so opening
 * a card twice, or a chat again, never reads it twice. A failed read is
 * forgotten so the next open tries again.
 */
export function createWholeItemReader(
	read: (sessionId: string, itemId: string) => Promise<unknown | null>,
) {
	const reads = new Map<string, Promise<unknown | null>>();
	/** `version` tells apart the states of one item (a running call's output grows). */
	return function wholeItem(sessionId: string, itemId: string, version = "") {
		const key = `${sessionId}|${itemId}|${version}`;
		const held = reads.get(key);
		if (held) return held;
		const next = read(sessionId, itemId).catch((error) => {
			reads.delete(key);
			throw error;
		});
		reads.set(key, next);
		return next;
	};
}

const readWholeItem = createWholeItemReader(async (sessionId, itemId) => {
	const json = await getSessionItemDetail({ data: { sessionId, itemId } });
	return json === null ? null : (JSON.parse(json) as unknown);
});

/**
 * The item as the page carried it until it is cut and `enabled` (its card or
 * canvas is open), then the whole item read by id. An in-progress call is
 * read again each time it changes: its output is still growing.
 */
export function useWholeItem<Item extends CutItem | null>(
	item: Item,
	enabled = true,
): Item {
	const [whole, setWhole] = useState<{ key: string; item: CutItem } | null>(
		null,
	);
	const cut = enabled && item !== null && isCut(item);
	const id = item?.id;
	const session = item?.detailSession;
	const version = item && "status" in item ? item.status : "";
	const key = `${id}|${version}`;
	useEffect(() => {
		if (!cut || !session || !id) return;
		let live = true;
		readWholeItem(session, id, version)
			.then((found) => {
				if (live && found && (found as CutItem).id === id)
					setWhole({ key, item: found as CutItem });
			})
			.catch(() => undefined);
		return () => {
			live = false;
		};
	}, [cut, session, id, version, key]);
	if (!cut || whole?.key !== key) return item;
	return {
		...whole.item,
		truncated: false,
		htmlOmitted: false,
	} as unknown as Item;
}
