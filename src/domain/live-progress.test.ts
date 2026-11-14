import { expect, it } from "vitest";
import { createLiveProgressCopy } from "./live-progress";

const sessionId = "00000000-0000-4000-8000-000000000002";
const item = (id: string) => ({ kind: "agentMessage", id, text: id });
const full = (itemsRev: string, n: number) => ({
	sessionId,
	turnStatus: "running",
	items: Array.from({ length: n }, (_, index) => item(`i${index}`)),
	hasOlderItems: false,
	window: { itemsRev, first: 0, end: n, hidden: [] },
});
const delta = (baseItemsRev: string, itemsRev: string, position: number) => ({
	sessionId,
	baseItemsRev,
	window: { itemsRev, first: 0, end: position + 1 },
	rows: [{ position, item: item(`i${position}`) }],
	queued: [],
	hasOlderItems: false,
	turnStatus: "running",
});
const ids = (progress: unknown) =>
	(progress as { items: { id: string }[] }).items.map((entry) => entry.id);

it("merges a chain of deltas into the last full snapshot", () => {
	const live = createLiveProgressCopy(sessionId);
	expect(ids(live.full(full("4", 2)))).toEqual(["i0", "i1"]);
	expect(ids(live.delta(delta("4", "5", 2)))).toEqual(["i0", "i1", "i2"]);
	expect(ids(live.delta(delta("5", "6", 3)))).toEqual(["i0", "i1", "i2", "i3"]);
});

it("asks for a full snapshot after a missed delta, and takes deltas again after it", () => {
	const live = createLiveProgressCopy(sessionId);
	live.full(full("4", 2));
	// Revision 5 never arrived.
	expect(live.delta(delta("5", "6", 3))).toBe("resync");
	// The copy is dropped: nothing merges until a full snapshot.
	expect(live.delta(delta("4", "5", 2))).toBe("resync");
	live.full(full("6", 4));
	expect(ids(live.delta(delta("6", "7", 4)))).toHaveLength(5);
});

it("takes no delta before a full snapshot, or after one without a window (an older server)", () => {
	const live = createLiveProgressCopy(sessionId);
	expect(live.delta(delta("4", "5", 2))).toBe("resync");
	const { window: _window, ...legacy } = full("4", 2);
	expect(ids(live.full(legacy))).toEqual(["i0", "i1"]);
	expect(live.delta(delta("4", "5", 2))).toBe("resync");
});

it("ignores another chat's events and asks again on a malformed delta", () => {
	const live = createLiveProgressCopy(sessionId);
	live.full(full("4", 2));
	expect(live.full({ ...full("4", 2), sessionId: "other" })).toBeNull();
	expect(live.delta({ ...delta("4", "5", 2), sessionId: "other" })).toBeNull();
	expect(live.delta({ sessionId, rows: "nonsense" })).toBe("resync");
});
