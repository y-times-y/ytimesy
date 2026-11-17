import type { SidebarChat, SidebarStatusGroup } from "./sidebar-chats";

/**
 * A Y project's sidebar reads as a tree of work: its Y² chat
 * (src/domain/y-squared.ts) heads the project's threads.
 */

/** Finished threads shown under Y² before "Show N more". */
export const Y2_THREADS_VISIBLE = 8;

/** Projects whose Y² branch the user folded, in this browser. */
export const SIDEBAR_COLLAPSED_Y2_KEY = "ytimesy-sidebar-collapsed-y2";

export type Y2Thread<Chat extends SidebarChat> = {
	readonly chat: Chat;
	/** Finished, not open: may fold away behind "Show N more". */
	readonly foldable: boolean;
	/** Folded away unless the list is expanded. */
	readonly pastFold: boolean;
};

export type Y2ThreadTree<Chat extends SidebarChat> = {
	readonly head: Chat;
	/** Pinned first, then as listed (newest first). */
	readonly threads: readonly Y2Thread<Chat>[];
	/** Finished threads past the fold: hidden unless expanded. */
	readonly overflowCount: number;
	readonly needsYouCount: number;
	/** Threads with a turn running: Y²'s mark is live while there are any. */
	readonly workingCount: number;
};

/**
 * The project's chats as a Y² tree, or null when the project has no Y² chat.
 * Threads that need the user, are working or are open always show; the
 * finished rest show their first Y2_THREADS_VISIBLE (pins take those slots
 * first). With `keepFolded` the folded threads stay in the list, marked
 * pastFold: the server renders them so the first-paint script can swap in a
 * saved pin (src/features/app/first-paint.ts).
 */
export function y2ThreadTree<Chat extends SidebarChat>(input: {
	readonly chats: readonly Chat[];
	readonly pinnedIds: readonly string[];
	readonly selectedChatId?: string;
	readonly statusOf: (chat: Chat) => SidebarStatusGroup;
	readonly expanded: boolean;
	readonly keepFolded?: boolean;
}): Y2ThreadTree<Chat> | null {
	const head = input.chats.find((chat) => chat.role === "y2");
	if (!head) return null;
	const pinned = new Set(input.pinnedIds);
	const threads = input.chats.filter((chat) => chat.role !== "y2");
	const ordered = [
		...threads.filter((chat) => pinned.has(chat.id)),
		...threads.filter((chat) => !pinned.has(chat.id)),
	];
	const statuses = new Map(
		ordered.map((chat) => [chat.id, input.statusOf(chat)]),
	);
	let finishedSeen = 0;
	const rows = ordered.map((chat): Y2Thread<Chat> => {
		const foldable =
			chat.id !== input.selectedChatId && statuses.get(chat.id) === "done";
		const pastFold =
			foldable && finishedSeen++ >= Y2_THREADS_VISIBLE && !input.expanded;
		return { chat, foldable, pastFold };
	});
	return {
		head,
		threads: input.keepFolded ? rows : rows.filter((row) => !row.pastFold),
		overflowCount: Math.max(0, finishedSeen - Y2_THREADS_VISIBLE),
		needsYouCount: ordered.filter(
			(chat) => statuses.get(chat.id) === "needs-you",
		).length,
		workingCount: ordered.filter((chat) => statuses.get(chat.id) === "working")
			.length,
	};
}

/** "3 threads need you", for the Y² row's badge. */
export function y2NeedsYouLabel(count: number) {
	return `${count} ${count === 1 ? "thread needs" : "threads need"} you`;
}
