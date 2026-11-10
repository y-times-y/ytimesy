import type { SessionItem } from "./session-item";

/** The active turn keeps at most about this much serialized item text. */
export const ACTIVE_TURN_ITEM_BYTES = 1_000_000;
const PREVIEW_CHARACTERS = 2_000;
const TRIMMED_MARK = "\n… (older output trimmed)";
/** The newest tool outputs stay whole: they are what the user is reading. */
const KEPT_NEWEST_OUTPUTS = 20;

const preview = (text: string) =>
	text.length > PREVIEW_CHARACTERS + TRIMMED_MARK.length
		? text.slice(0, PREVIEW_CHARACTERS) + TRIMMED_MARK
		: text;

function trimmedOutputs(item: SessionItem): SessionItem {
	if (item.kind === "commandExecution" && item.output)
		return { ...item, output: preview(item.output) };
	if (item.kind === "dynamicToolCall")
		return {
			...item,
			...(item.input ? { input: preview(item.input) } : {}),
			...(item.output ? { output: preview(item.output) } : {}),
		};
	return item;
}

const weight = (item: SessionItem) =>
	item.kind === "commandExecution"
		? (item.output?.length ?? 0)
		: item.kind === "dynamicToolCall"
			? (item.input?.length ?? 0) + (item.output?.length ?? 0)
			: 0;

/**
 * Bounds the items from `activeFrom` on: past the byte budget, tool outputs
 * are cut to a preview oldest first until it fits, keeping the newest ones
 * whole. Items before `activeFrom` (earlier turns) are untouched, and the same
 * array comes back when nothing needs trimming, so callers can compare by
 * identity. Outputs are display text; the model's history is separate.
 */
export function boundActiveTurnItems(
	items: SessionItem[],
	activeFrom: number,
	budget = ACTIVE_TURN_ITEM_BYTES,
): SessionItem[] {
	if (activeFrom < 0 || activeFrom >= items.length) return items;
	let remaining = 0;
	const candidates: number[] = [];
	for (let index = activeFrom; index < items.length; index++) {
		const size = weight(items[index]);
		remaining += size;
		if (size > PREVIEW_CHARACTERS + TRIMMED_MARK.length) candidates.push(index);
	}
	// Only output text is counted: every other item is small and bounded.
	if (remaining <= budget) return items;
	const trimmable = candidates.slice(
		0,
		Math.max(0, candidates.length - KEPT_NEWEST_OUTPUTS),
	);
	const next = [...items];
	for (const index of trimmable) {
		if (remaining <= budget) break;
		const before = weight(next[index]);
		next[index] = trimmedOutputs(next[index]);
		remaining -= before - weight(next[index]);
	}
	return next;
}
