import { describe, expect, it } from "vitest";
import {
	applyConversationDelta,
	type ConversationDeltaBody,
	conversationDeltaEvent,
	conversationEvent,
} from "./conversation-delivery";

const sessionId = "00000000-0000-4000-8000-000000000001";
const item = (id: string, text = id) => ({ kind: "agentMessage", id, text });
const queued = (id: string) => ({
	kind: "userMessage",
	id,
	text: id,
	queued: true,
});

/** Stored positions 10..14 at revision 5; position 12 is not shown; one queued message. */
const copy = {
	progress: {
		sessionId,
		items: [item("p10"), item("p11"), item("p13"), item("p14"), queued("q1")],
	},
	window: { itemsRev: "5", first: 10, end: 15, hidden: [12] },
};
const delta = (
	body: Partial<ConversationDeltaBody> & {
		window: ConversationDeltaBody["window"];
	},
): ConversationDeltaBody => ({
	baseItemsRev: "5",
	rows: [],
	queued: [],
	hasOlderItems: true,
	turnStatus: "running",
	...body,
});
const ids = (items: readonly unknown[]) =>
	items.map((entry) => (entry as { id: string }).id);

describe("applyConversationDelta", () => {
	it("appends new rows and replaces a changed one in place", () => {
		const merged = applyConversationDelta(
			copy,
			delta({
				window: { itemsRev: "7", first: 10, end: 17 },
				rows: [
					{ position: 11, item: item("p11", "edited") },
					{ position: 15, item: item("p15") },
					{ position: 16, item: item("p16") },
				],
				queued: [queued("q1")],
			}),
		);
		expect(ids(merged?.progress.items ?? [])).toEqual([
			"p10",
			"p11",
			"p13",
			"p14",
			"p15",
			"p16",
			"q1",
		]);
		expect(merged?.progress.items[1]).toEqual(item("p11", "edited"));
		expect(merged?.window).toEqual({
			itemsRev: "7",
			first: 10,
			end: 17,
			hidden: [12],
		});
		expect(merged?.progress.turnStatus).toBe("running");
	});

	it("drops removed rows past the new end and rows before the new start", () => {
		const merged = applyConversationDelta(
			copy,
			delta({ window: { itemsRev: "6", first: 11, end: 13 } }),
		);
		expect(ids(merged?.progress.items ?? [])).toEqual(["p11"]);
		expect(merged?.window.hidden).toEqual([12]);
		// The queued message was taken: the delta no longer lists it.
		expect(ids(merged?.progress.items ?? [])).not.toContain("q1");
	});

	it("replaces a row with one the view drops, and shows a hidden row that became visible", () => {
		const merged = applyConversationDelta(
			copy,
			delta({
				window: { itemsRev: "6", first: 10, end: 15 },
				rows: [
					{ position: 10, item: null },
					{ position: 12, item: item("p12") },
				],
			}),
		);
		expect(ids(merged?.progress.items ?? [])).toEqual([
			"p11",
			"p12",
			"p13",
			"p14",
		]);
		expect(merged?.window.hidden).toEqual([10]);
	});

	it("shows a queued message only until the transcript holds it", () => {
		const merged = applyConversationDelta(
			copy,
			delta({
				window: { itemsRev: "6", first: 10, end: 16 },
				rows: [{ position: 15, item: { ...queued("q1"), queued: undefined } }],
				queued: [queued("q1"), queued("q2")],
			}),
		);
		expect(ids(merged?.progress.items ?? [])).toEqual([
			"p10",
			"p11",
			"p13",
			"p14",
			"q1",
			"q2",
		]);
		expect(merged?.progress.items.at(-2)).not.toHaveProperty("queued", true);
	});

	it("a status-only change keeps every row", () => {
		const merged = applyConversationDelta(
			copy,
			delta({
				window: { itemsRev: "5", first: 10, end: 15 },
				turnStatus: "completed",
				usage: { used: 1 },
			}),
		);
		expect(ids(merged?.progress.items ?? [])).toEqual([
			"p10",
			"p11",
			"p13",
			"p14",
		]);
		expect(merged?.progress.turnStatus).toBe("completed");
		expect(merged?.progress.usage).toEqual({ used: 1 });
	});

	it("refuses a delta for another revision: a missed delta is never papered over", () => {
		expect(
			applyConversationDelta(
				copy,
				delta({
					baseItemsRev: "4",
					window: { itemsRev: "7", first: 10, end: 16 },
					rows: [{ position: 15, item: item("p15") }],
				}),
			),
		).toBeNull();
	});

	it("refuses a window that grew back over rows the copy never held", () => {
		expect(
			applyConversationDelta(
				copy,
				delta({ window: { itemsRev: "6", first: 8, end: 15 } }),
			),
		).toBeNull();
		// Unless the delta carries them.
		const merged = applyConversationDelta(
			copy,
			delta({
				window: { itemsRev: "6", first: 9, end: 15 },
				rows: [{ position: 9, item: item("p9") }],
			}),
		);
		expect(ids(merged?.progress.items ?? [])[0]).toBe("p9");
	});

	it("refuses a copy without a window (a server that predates deltas) or a short one", () => {
		expect(
			applyConversationDelta(
				{ progress: copy.progress },
				delta({ window: { itemsRev: "5", first: 10, end: 15 } }),
			),
		).toBeNull();
		expect(
			applyConversationDelta(
				{ ...copy, progress: { sessionId, items: [item("p10")] } },
				delta({ window: { itemsRev: "5", first: 10, end: 15 } }),
			),
		).toBeNull();
	});
});

describe("events", () => {
	it("keeps the full event's shape for older pages, adding only the window", () => {
		const event = conversationEvent({
			userId: "alice",
			sessionId,
			revision: "3",
			progress: { ...copy.progress, turnStatus: "running" },
			window: copy.window,
		});
		expect(event.startsWith("retry: 250\nid: 3\nevent: progress\ndata: ")).toBe(
			true,
		);
		const data = JSON.parse(event.split("data: ")[1]);
		expect(data.items).toEqual(copy.progress.items);
		expect(data.window).toEqual(copy.window);
	});

	it("sends a delta as its own event without the owner", () => {
		const event = conversationDeltaEvent({
			kind: "delta",
			userId: "alice",
			sessionId,
			revision: "4",
			...delta({ window: { itemsRev: "5", first: 10, end: 15 } }),
		});
		expect(event.startsWith("id: 4\nevent: delta\ndata: ")).toBe(true);
		const data = JSON.parse(event.split("data: ")[1]);
		expect(data).not.toHaveProperty("userId");
		expect(data.sessionId).toBe(sessionId);
	});
});
