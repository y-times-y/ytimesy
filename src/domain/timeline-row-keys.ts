import type { SessionItem } from "./session-item";
import type { TimelineRow } from "./timeline-activity";

/** Which list key each grouped item was last shown under (items of work and exploration rows). */
export type RowKeyMemory = ReadonlyMap<SessionItem["id"], string>;

const defaultKey = (row: TimelineRow) =>
	row.kind === "item" ? row.item.id : `${row.kind}:${row.id}`;

/**
 * The key each row has in the transcript list.
 *
 * A grouped row (work, exploration) is named by its first item. A chat loads
 * in pages of at most 200 items, and a long turn holds far more, so a page
 * often starts inside a turn: the first row of the view is then that turn's
 * group as far as it has loaded. Reading the older page adds the group's
 * earlier items, its first item changes, and so would its key. The list finds
 * the reader's place again by the key of the row at the top of the view, so a
 * key that changed lost it, and the view stayed at its old scroll number: near
 * the top of the chat, far from where the reader was.
 *
 * A group that holds an item already shown in a group keeps that group's key,
 * so it is the same row after the page joins it. Two rows never share a key.
 */
export function timelineRowKeys(
	rows: readonly TimelineRow[],
	remembered?: RowKeyMemory,
): {
	readonly keys: ReadonlyMap<TimelineRow, string>;
	readonly memory: RowKeyMemory;
} {
	const keys = new Map<TimelineRow, string>();
	const memory = new Map<SessionItem["id"], string>();
	const taken = new Set<string>();
	for (const row of rows) {
		let key = defaultKey(row);
		if (row.kind !== "item") {
			for (const item of row.items) {
				const earlier = remembered?.get(item.id);
				if (earlier !== undefined && !taken.has(earlier)) {
					key = earlier;
					break;
				}
			}
		}
		// A key another row holds already (a group that split): a new one.
		for (let attempt = 1; taken.has(key); attempt++)
			key = `${defaultKey(row)}#${attempt}`;
		taken.add(key);
		keys.set(row, key);
		if (row.kind !== "item")
			for (const item of row.items) memory.set(item.id, key);
	}
	return { keys, memory };
}
