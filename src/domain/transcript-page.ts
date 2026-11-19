import { startsTurn } from "./child-task-activity";
import type { SessionItem } from "./session-item";

/**
 * A long chat loads in pages of whole turns, newest first: opening it reads
 * its last TRANSCRIPT_PAGE_TURNS turns, and scrolling up reads the items
 * before the oldest one shown. Whole turns are preferred, but a large turn
 * is split at item boundaries to keep each delivery bounded. Nothing is deleted.
 */
export const TRANSCRIPT_PAGE_TURNS = 30;
/**
 * A chat opens (and a send or a recovery read answers) on its last
 * OPEN_PAGE_TURNS turns. Four turns fill a screen in practice and cost ~40% of
 * the ten the page used to carry (a ten-turn page averaged 60-70 KB after the
 * payload diet); older turns load on scroll (TRANSCRIPT_PAGE_TURNS each).
 * Re-reads of a chat the browser already holds are not pages at all: they
 * are revision deltas (session-delta.ts). A page is the last turns whole, so
 * a running turn (always the last) is never cut.
 */
export const OPEN_PAGE_TURNS = 4;
/** An open page never has fewer than the chat's last two turns, whatever a caller asks. */
export const OPEN_PAGE_MIN_TURNS = 2;
/**
 * Short turns may not fill the viewport: an open page with fewer items than
 * this (and older turns to read) is read again with OPEN_PAGE_FALLBACK_TURNS.
 */
export const OPEN_PAGE_MIN_ITEMS = 16;
export const OPEN_PAGE_FALLBACK_TURNS = 10;
/**
 * The live snapshot carries only the chat's last SNAPSHOT_TURNS turns. The
 * browser already shows the older ones (it merges a snapshot onto them; see
 * withEarlierPages) and reads more by paging, so re-sending thirty turns on
 * every progress update only moved megabytes out of Postgres: on the two longest
 * production chats six turns were 2 to 18 percent of thirty.
 */
export const SNAPSHOT_TURNS = 6;
/** A single long turn must not make every live update load an unbounded history. */
export const TRANSCRIPT_PAGE_ITEMS = 200;
export const TRANSCRIPT_PAGE_BYTES = 256 * 1024;
const transcriptEncoder = new TextEncoder();

/** Some transcript items, and whether the chat holds turns before them. */
export type TranscriptPage<Item = SessionItem> = {
	readonly items: readonly Item[];
	readonly hasOlderItems: boolean;
};

/**
 * The page that ends just before `end` (exclusive; the whole transcript by
 * default): its last `turns` turns. Items before the first turn start (none
 * in practice) belong to the oldest page.
 */
export function transcriptPageBefore<Item extends SessionItem>(
	items: readonly Item[],
	end = items.length,
	turns = TRANSCRIPT_PAGE_TURNS,
): TranscriptPage<Item> {
	let found = 0;
	let bytes = 0;
	const minimum = Math.max(0, end - TRANSCRIPT_PAGE_ITEMS);
	for (let index = end - 1; index >= minimum; index--) {
		bytes += transcriptEncoder.encode(JSON.stringify(items[index])).byteLength;
		// Always return one item, even a single oversized user message.
		if (bytes > TRANSCRIPT_PAGE_BYTES && index < end - 1)
			return { items: items.slice(index + 1, end), hasOlderItems: true };
		if (!startsTurn(items[index] as SessionItem)) continue;
		found++;
		if (found === turns && index > 0)
			return { items: items.slice(index, end), hasOlderItems: true };
	}
	return { items: items.slice(minimum, end), hasOlderItems: minimum > 0 };
}

/** The open page: the chat's last turns. */
export function latestTranscriptPage<Item extends SessionItem>(
	items: readonly Item[],
	turns = TRANSCRIPT_PAGE_TURNS,
): TranscriptPage<Item> {
	return transcriptPageBefore(items, items.length, turns);
}

/**
 * The page before the item `beforeId` (the oldest one the reader has).
 * Null when the transcript no longer holds that item (a restore rewrote it):
 * the reader then reads the chat again.
 */
export function olderTranscriptPage<Item extends SessionItem>(
	items: readonly Item[],
	beforeId: string,
	turns = TRANSCRIPT_PAGE_TURNS,
): TranscriptPage<Item> | null {
	const end = items.findIndex((item) => item.id === beforeId);
	return end < 0 ? null : transcriptPageBefore(items, end, turns);
}

/** A chat view as the browser holds it: some of its latest items. */
type PagedView = {
	readonly agentSessionId?: string | null;
	readonly items: readonly SessionItem[];
	readonly hasOlderItems?: boolean;
};

/**
 * A newer view of the open chat over the one shown: the server sends only
 * its latest page, so the older pages the reader already loaded stay above
 * it. They join where the new page begins (by item id); a new page that
 * starts after everything shown (many turns ran meanwhile) or a rewritten
 * transcript replaces them.
 */
export function withEarlierPages<View extends PagedView>(
	current: PagedView | undefined,
	next: View,
): View {
	if (
		!current ||
		!next.hasOlderItems ||
		!next.agentSessionId ||
		current.agentSessionId !== next.agentSessionId
	)
		return next;
	const first = next.items[0];
	if (!first) return next;
	const at = current.items.findIndex((item) => item.id === first.id);
	if (at <= 0) return next;
	return {
		...next,
		items: [...current.items.slice(0, at), ...next.items],
		hasOlderItems: Boolean(current.hasOlderItems),
	};
}

/**
 * An older page above the view, if the view still starts where the page was
 * read from (the same chat, the same oldest item).
 */
export function withOlderPage<View extends PagedView>(
	view: View,
	page: TranscriptPage & { readonly chatId: string; readonly beforeId: string },
): View {
	if (
		view.agentSessionId !== page.chatId ||
		view.items[0]?.id !== page.beforeId
	)
		return view;
	const shown = new Set(view.items.map((item) => item.id));
	return {
		...view,
		items: [...page.items.filter((item) => !shown.has(item.id)), ...view.items],
		hasOlderItems: page.hasOlderItems,
	};
}

/**
 * A live snapshot as the reader's last page. A relay deployed before pages
 * sends the whole transcript without the flag: it is cut to the last page
 * here, so it neither floods the view nor hides the pages above.
 */
export function progressPage(progress: {
	readonly items: readonly SessionItem[];
	readonly hasOlderItems?: boolean;
}): TranscriptPage {
	const page = latestTranscriptPage(progress.items);
	return {
		items: page.items,
		hasOlderItems: Boolean(progress.hasOlderItems) || page.hasOlderItems,
	};
}

/**
 * Whether a snapshot starts after everything the view shows: its first item is
 * not in the view although the chat has older turns, so merging it would drop
 * the older pages (or the snapshot would be refused). That happens to a view
 * that missed more than SNAPSHOT_TURNS turns (a tab that slept through a long
 * goal run); the caller then reads the chat again instead of waiting.
 */
export function snapshotLeavesGap(
	current: readonly SessionItem[],
	next: TranscriptPage,
): boolean {
	const first = next.items[0];
	return (
		Boolean(first) &&
		next.hasOlderItems &&
		current.length > 0 &&
		!current.some((item) => item.id === first.id)
	);
}
