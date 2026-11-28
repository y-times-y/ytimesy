import { describe, expect, it } from "vitest";
import { childTaskEventQueueText } from "./child-task-activity";
import type { SessionItem } from "./session-item";
import {
	latestTranscriptPage,
	olderTranscriptPage,
	progressPage,
	SNAPSHOT_TURNS,
	snapshotLeavesGap,
	TRANSCRIPT_PAGE_ANCHOR_ITEMS,
	TRANSCRIPT_PAGE_BYTES,
	TRANSCRIPT_PAGE_ITEMS,
	TRANSCRIPT_PAGE_TURNS,
	withEarlierPages,
	withOlderPage,
} from "./transcript-page";

const user = (id: string): SessionItem => ({
	kind: "userMessage",
	id: id as never,
	text: id,
});
const reply = (id: string): SessionItem => ({
	kind: "agentMessage",
	id: id as never,
	text: id,
});
const turn = (n: number) => [user(`u${n}`), reply(`a${n}`), reply(`b${n}`)];
const turns = (from: number, to: number) =>
	Array.from({ length: to - from }, (_, index) => turn(from + index)).flat();
const ids = (items: readonly SessionItem[]) => items.map((item) => item.id);

describe("bounded transcript pages", () => {
	it("splits a long turn at item boundaries and keeps every item pageable", () => {
		const items = [
			user("start"),
			...Array.from({ length: 501 }, (_, n) => reply(`work-${n}`)),
		];
		let page = latestTranscriptPage(items);
		let all = [...page.items];
		expect(page.items).toHaveLength(TRANSCRIPT_PAGE_ITEMS);
		while (page.hasOlderItems) {
			const first = page.items[0];
			if (!first) throw new Error("An older-page cursor is required.");
			const older = olderTranscriptPage(items, first.id);
			if (!older) throw new Error("The cursor must remain in the transcript.");
			page = older;
			all = [...page.items, ...all];
		}
		expect(ids(all)).toEqual(ids(items));
	});
	it("bounds large Unicode output but never hides an individual oversized item", () => {
		const items = [
			user("ask"),
			...Array.from({ length: 10 }, (_, n) => ({
				...reply(`unicode-${n}`),
				text: "🧭".repeat(20_000),
			})),
		];
		const page = latestTranscriptPage(items);
		expect(page.hasOlderItems).toBe(true);
		expect(
			new TextEncoder().encode(JSON.stringify(page.items)).length,
		).toBeLessThan(TRANSCRIPT_PAGE_BYTES);
		const enormous = {
			...reply("single"),
			text: "x".repeat(TRANSCRIPT_PAGE_BYTES + 1),
		};
		expect(latestTranscriptPage([user("previous"), enormous]).items).toEqual([
			enormous,
		]);
	});
	it("cuts at a turn start, never inside a turn", () => {
		const page = latestTranscriptPage(turns(0, 5), 2);
		expect(ids(page.items)).toEqual(["u3", "a3", "b3", "u4", "a4", "b4"]);
		expect(page.hasOlderItems).toBe(true);
	});

	it("takes all of a chat with no more turns than a page, and an empty chat", () => {
		expect(latestTranscriptPage(turns(0, 2), 2)).toEqual({
			items: turns(0, 2),
			hasOlderItems: false,
		});
		expect(latestTranscriptPage([], 2)).toEqual({
			items: [],
			hasOlderItems: false,
		});
	});

	it("reads the page before an item, and nothing for an item the chat lost", () => {
		const items = turns(0, 5);
		expect(ids(olderTranscriptPage(items, "u3", 2)?.items ?? [])).toEqual([
			"u1",
			"a1",
			"b1",
			"u2",
			"a2",
			"b2",
		]);
		expect(olderTranscriptPage(items, "u1", 2)).toEqual({
			items: turn(0),
			hasOlderItems: false,
		});
		expect(olderTranscriptPage(items, "u0", 2)).toEqual({
			items: [],
			hasOlderItems: false,
		});
		expect(olderTranscriptPage(items, "missing", 2)).toBeNull();
	});
});

describe("the browser's copy of a paged chat", () => {
	const shown = {
		agentSessionId: "chat",
		items: turns(2, 6),
		hasOlderItems: true,
	};

	it("keeps loaded older pages above a newer last page", () => {
		const next = {
			agentSessionId: "chat",
			items: turns(4, 7),
			hasOlderItems: true,
		};
		const merged = withEarlierPages(shown, next);
		expect(ids(merged.items)).toEqual(ids(turns(2, 7)));
		expect(merged.hasOlderItems).toBe(true);
	});

	it("takes a whole transcript, another chat, or a page past everything shown as it is", () => {
		const whole = {
			agentSessionId: "chat",
			items: turns(0, 7),
			hasOlderItems: false,
		};
		expect(withEarlierPages(shown, whole)).toBe(whole);
		const other = {
			agentSessionId: "other",
			items: turns(4, 7),
			hasOlderItems: true,
		};
		expect(withEarlierPages(shown, other)).toBe(other);
		const later = {
			agentSessionId: "chat",
			items: turns(9, 12),
			hasOlderItems: true,
		};
		expect(withEarlierPages(shown, later)).toBe(later);
		expect(withEarlierPages(undefined, later)).toBe(later);
	});

	it("puts an older page above the view it was read for, once", () => {
		const page = {
			chatId: "chat",
			beforeId: "u2",
			items: turns(0, 2),
			hasOlderItems: false,
		};
		const merged = withOlderPage(shown, page);
		expect(ids(merged.items)).toEqual(ids(turns(0, 6)));
		expect(merged.hasOlderItems).toBe(false);
		// Read again for a view that already starts earlier: nothing changes.
		expect(withOlderPage(merged, page)).toBe(merged);
		// Another chat opened meanwhile keeps its own transcript.
		const other = { ...shown, agentSessionId: "other" };
		expect(withOlderPage(other, page)).toBe(other);
	});

	it("cuts a live snapshot to the last page, from a relay that sends the whole chat too", () => {
		expect(progressPage({ items: turns(0, 2), hasOlderItems: true })).toEqual({
			items: turns(0, 2),
			hasOlderItems: true,
		});
		expect(progressPage({ items: turns(0, 2) }).hasOlderItems).toBe(false);
		const whole = progressPage({ items: turns(0, TRANSCRIPT_PAGE_TURNS + 2) });
		expect(ids(whole.items)).toEqual(ids(turns(2, TRANSCRIPT_PAGE_TURNS + 2)));
		expect(whole.hasOlderItems).toBe(true);
	});
});

describe("a short live snapshot onto the view the browser already has", () => {
	const shown = (from: number, to: number) => ({
		agentSessionId: "chat",
		items: turns(from, to),
		hasOlderItems: true,
	});
	const snapshot = (from: number, to: number) => ({
		agentSessionId: "chat",
		items: turns(from, to),
		hasOlderItems: true,
	});

	it("carries far fewer turns than a page, and a page still covers it", () => {
		expect(SNAPSHOT_TURNS).toBeGreaterThanOrEqual(2);
		expect(SNAPSHOT_TURNS).toBeLessThan(TRANSCRIPT_PAGE_TURNS);
	});

	it("keeps the older turns already shown and updates the tail", () => {
		const view = shown(1, 31);
		const tail = snapshot(31 - SNAPSHOT_TURNS + 1, 32);
		expect(snapshotLeavesGap(view.items, tail)).toBe(false);
		const merged = withEarlierPages(view, tail);
		expect(ids(merged.items)).toEqual(ids(turns(1, 32)));
		expect(merged.hasOlderItems).toBe(true);
	});

	it("follows a new turn that slides the window by one", () => {
		const view = shown(1, 31);
		const slid = snapshot(32 - SNAPSHOT_TURNS + 1, 33);
		expect(snapshotLeavesGap(view.items, slid)).toBe(false);
		expect(ids(withEarlierPages(view, slid).items)).toEqual(ids(turns(1, 33)));
	});

	it("reports a gap when the view missed more turns than a snapshot carries", () => {
		const view = shown(1, 21);
		const far = snapshot(40, 47);
		expect(snapshotLeavesGap(view.items, far)).toBe(true);
	});

	it("reports no gap for an empty view, a whole-chat snapshot, or no older turns", () => {
		expect(snapshotLeavesGap([], snapshot(40, 47))).toBe(false);
		expect(
			snapshotLeavesGap(turns(1, 3), {
				items: turns(1, 3),
				hasOlderItems: false,
			}),
		).toBe(false);
		expect(
			snapshotLeavesGap(turns(5, 9), { items: [], hasOlderItems: true }),
		).toBe(false);
	});
});

describe("pages over a chat that wakes constantly (the Super agent)", () => {
	const wake = (n: number): SessionItem => ({
		kind: "userMessage",
		id: `wake-${n}` as never,
		text: childTaskEventQueueText(
			`6f1c2a9e-0d4b-4c51-9a63-2f8f5b1d${String(n).padStart(4, "0")}`,
		),
	});
	const person = (id: string): SessionItem => ({
		kind: "userMessage",
		id: id as never,
		text: `person ${id}`,
	});
	const reply = (id: string): SessionItem => ({
		kind: "agentMessage",
		id: id as never,
		text: `reply ${id}`,
	});
	const wakeTurns = (from: number, count: number) =>
		Array.from({ length: count }, (_, index) => [
			wake(from + index),
			reply(`a-${from + index}`),
		]).flat();

	it("counts the person's turns, so their latest message is on the open page", () => {
		const items = [
			person("p1"),
			reply("r1"),
			...wakeTurns(0, 40),
			person("p2"),
			reply("r2"),
			...wakeTurns(100, 40),
		];
		const page = latestTranscriptPage(items, 2);
		expect(page.items.map((item) => item.id)).toContain("p2");
		expect(page.items.map((item) => item.id)).toContain("p1");
	});

	it("a chat of thousands of wake items still pages by what the person sees", () => {
		const items = [
			...wakeTurns(0, 1_500),
			person("p1"),
			reply("r1"),
			...wakeTurns(2_000, 1_500),
			person("p2"),
			reply("r2"),
			...wakeTurns(4_000, 150),
		];
		expect(items.length).toBeGreaterThan(5_000);
		const page = latestTranscriptPage(items, 2);
		const ids = page.items.map((item) => item.id);
		// Thousands of replies lie between the two messages: the page keeps the
		// latest one (and everything after it) and the rest pages in on scroll.
		expect(ids).toContain("p2");
		expect(ids).toContain("r2");
		expect(ids).not.toContain("p1");
		expect(page.hasOlderItems).toBe(true);
	});

	it("hidden wake starts do not use up the page's item budget", () => {
		const items = [
			person("p1"),
			reply("r1"),
			...wakeTurns(0, TRANSCRIPT_PAGE_ITEMS),
		];
		const page = latestTranscriptPage(items, 1);
		expect(page.items.map((item) => item.id)).toContain("p1");
	});
});

describe("the person's latest message is anchored when wakes follow it", () => {
	const wakeStart = (n: number): SessionItem => ({
		kind: "userMessage",
		id: `wake-${n}` as never,
		text: childTaskEventQueueText(
			`6f1c2a9e-0d4b-4c51-9a63-2f8f5b1d${String(n).padStart(4, "0")}`,
		),
	});
	const wakeTurns = (count: number) =>
		Array.from({ length: count }, (_, n) => [
			wakeStart(n),
			reply(`wr-${n}`),
		]).flat();

	it("reaches back past the item limit, within the anchor distance", () => {
		const items = [
			user("p1"),
			reply("r1"),
			...wakeTurns(TRANSCRIPT_PAGE_ITEMS + 50),
		];
		const page = latestTranscriptPage(items, 1);
		expect(page.items.map((item) => item.id)).toContain("p1");
	});

	it("stays bounded beyond the anchor distance", () => {
		const items = [
			user("p1"),
			reply("r1"),
			...wakeTurns(TRANSCRIPT_PAGE_ANCHOR_ITEMS + 50),
		];
		const page = latestTranscriptPage(items, 1);
		expect(page.items.map((item) => item.id)).not.toContain("p1");
		expect(page.hasOlderItems).toBe(true);
	});

	it("one long turn with no wakes still splits at the item limit", () => {
		const items = [
			user("p1"),
			...Array.from({ length: TRANSCRIPT_PAGE_ITEMS + 50 }, (_, n) =>
				reply(`long-${n}`),
			),
		];
		const page = latestTranscriptPage(items, 1);
		expect(page.items.length).toBe(TRANSCRIPT_PAGE_ITEMS);
		expect(page.hasOlderItems).toBe(true);
	});
});
