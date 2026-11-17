import { describe, expect, it } from "vitest";
import type { SidebarChat, SidebarStatusGroup } from "./sidebar-chats";
import {
	Y2_THREADS_VISIBLE,
	y2NeedsYouLabel,
	y2ThreadTree,
} from "./sidebar-tree";

const y2: SidebarChat = { id: "y2", title: "Y²", role: "y2" };
const finished = (count: number, from = 0): SidebarChat[] =>
	Array.from({ length: count }, (_, index) => ({
		id: `t${from + index}`,
		title: `Thread ${from + index}`,
	}));

function tree(
	chats: readonly SidebarChat[],
	options: {
		pinnedIds?: readonly string[];
		selectedChatId?: string;
		statuses?: Record<string, SidebarStatusGroup>;
		expanded?: boolean;
		keepFolded?: boolean;
	} = {},
) {
	return y2ThreadTree({
		chats,
		pinnedIds: options.pinnedIds ?? [],
		selectedChatId: options.selectedChatId,
		statusOf: (chat) => options.statuses?.[chat.id] ?? "done",
		expanded: options.expanded ?? false,
		keepFolded: options.keepFolded,
	});
}

const ids = (result: ReturnType<typeof tree>) =>
	result?.threads.map((thread) => thread.chat.id);

describe("Y² thread tree", () => {
	it("is only for a project with a Y² chat", () => {
		expect(tree(finished(3))).toBeNull();
	});

	it("heads the threads with Y², wherever the list put it", () => {
		const result = tree([...finished(2), y2]);
		expect(result?.head.id).toBe("y2");
		expect(ids(result)).toEqual(["t0", "t1"]);
	});

	it("lists pinned threads first, the rest in the order they came", () => {
		expect(ids(tree([y2, ...finished(4)], { pinnedIds: ["t2"] }))).toEqual([
			"t2",
			"t0",
			"t1",
			"t3",
		]);
	});

	it("folds finished threads past the first few, never active or open ones", () => {
		const chats = [
			y2,
			...finished(Y2_THREADS_VISIBLE + 3),
			{ id: "asks", title: "Asks" },
			{ id: "busy", title: "Busy" },
			{ id: "open", title: "Open" },
		];
		const result = tree(chats, {
			selectedChatId: "open",
			statuses: { asks: "needs-you", busy: "working" },
		});
		expect(result?.overflowCount).toBe(3);
		expect(ids(result)).toEqual([
			...finished(Y2_THREADS_VISIBLE).map((chat) => chat.id),
			"asks",
			"busy",
			"open",
		]);
		expect(result?.threads.filter((thread) => thread.foldable)).toHaveLength(
			Y2_THREADS_VISIBLE,
		);
	});

	it("shows every thread once expanded, still counting what folds", () => {
		const result = tree([y2, ...finished(Y2_THREADS_VISIBLE + 2)], {
			expanded: true,
		});
		expect(result?.threads).toHaveLength(Y2_THREADS_VISIBLE + 2);
		expect(result?.threads.some((thread) => thread.pastFold)).toBe(false);
		expect(result?.overflowCount).toBe(2);
	});

	it("lets pins take the fold's first slots", () => {
		const chats = [y2, ...finished(Y2_THREADS_VISIBLE + 1)];
		const late = `t${Y2_THREADS_VISIBLE}`;
		const result = tree(chats, { pinnedIds: [late] });
		expect(ids(result)?.[0]).toBe(late);
		expect(ids(result)).not.toContain(`t${Y2_THREADS_VISIBLE - 1}`);
	});

	it("keeps folded threads, marked, for the server's first paint", () => {
		const result = tree([y2, ...finished(Y2_THREADS_VISIBLE + 2)], {
			keepFolded: true,
		});
		expect(result?.threads).toHaveLength(Y2_THREADS_VISIBLE + 2);
		expect(
			result?.threads.filter((thread) => thread.pastFold).map((t) => t.chat.id),
		).toEqual([`t${Y2_THREADS_VISIBLE}`, `t${Y2_THREADS_VISIBLE + 1}`]);
	});

	it("counts the threads that need the user", () => {
		const result = tree([y2, ...finished(4)], {
			statuses: {
				y2: "needs-you",
				t0: "needs-you",
				t1: "needs-you",
				t2: "working",
			},
		});
		// Y²'s own state is not a thread's.
		expect(result?.needsYouCount).toBe(2);
		expect(result?.workingCount).toBe(1);
	});

	it("words the badge for screen readers", () => {
		expect(y2NeedsYouLabel(1)).toBe("1 thread needs you");
		expect(y2NeedsYouLabel(3)).toBe("3 threads need you");
	});
});
