import { describe, expect, it } from "vitest";
import type { SessionItem } from "./session-item";
import {
	latestTranscriptPage,
	olderTranscriptPage,
	progressPage,
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

describe("pages of whole turns", () => {
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
