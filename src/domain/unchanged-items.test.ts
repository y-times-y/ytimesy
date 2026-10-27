import { describe, expect, it } from "vitest";
import type { SessionItemId } from "./ids";
import type { SessionItem } from "./session-item";
import type { TimelineRow } from "./timeline-activity";
import {
	reuseUnchangedItems,
	reuseUnchangedRows,
	sameJsonValue,
} from "./unchanged-items";

describe("sameJsonValue", () => {
	it("compares objects by keys and arrays by order", () => {
		expect(sameJsonValue({ a: [1, { b: "x" }] }, { a: [1, { b: "x" }] })).toBe(
			true,
		);
		expect(sameJsonValue({ a: 1 }, { a: 1, b: undefined })).toBe(false);
		expect(sameJsonValue([1, 2], [2, 1])).toBe(false);
		expect(sameJsonValue({ a: null }, { a: {} })).toBe(false);
		expect(sameJsonValue([], {})).toBe(false);
	});
});

describe("reuseUnchangedItems", () => {
	const user = { id: "u1", kind: "userMessage", text: "hi" };
	const reply = { id: "a1", kind: "agentMessage", text: "Hel" };

	it("keeps the previous objects of items whose data did not change", () => {
		const previous = [user, reply];
		const next = reuseUnchangedItems(previous, [
			structuredClone(user),
			{ ...reply, text: "Hello" },
		]);
		expect(next[0]).toBe(user);
		expect(next[1]).not.toBe(reply);
		expect(next[1]?.text).toBe("Hello");
	});

	it("returns the previous list itself when nothing changed", () => {
		const previous = [user, reply];
		expect(reuseUnchangedItems(previous, structuredClone(previous))).toBe(
			previous,
		);
	});

	it("returns a new list when items were added or removed", () => {
		const previous = [user];
		const next = reuseUnchangedItems(previous, [structuredClone(user), reply]);
		expect(next).not.toBe(previous);
		expect(next[0]).toBe(user);
		expect(reuseUnchangedItems([user, reply], [user])).toEqual([user]);
	});
});

describe("reuseUnchangedRows", () => {
	const items = [
		{ id: "c1", kind: "commandExecution" },
		{ id: "c2", kind: "commandExecution" },
	] as unknown as SessionItem[];
	const work = {
		kind: "work",
		id: "c1" as SessionItemId,
		label: "2s",
		items,
	} as const;

	it("keeps rows that show the same item objects", () => {
		const item: TimelineRow = { kind: "item", item: items[0] as SessionItem };
		const next = reuseUnchangedRows(
			[work, item],
			[
				{ ...work, items: [...items] },
				{ kind: "item", item: items[0] as SessionItem },
			],
		);
		expect(next[0]).toBe(work);
		expect(next[1]).toBe(item);
	});

	it("replaces rows whose items or label changed", () => {
		const [relabelled] = reuseUnchangedRows([work], [{ ...work, label: "3s" }]);
		expect(relabelled).not.toBe(work);
		const [grown] = reuseUnchangedRows(
			[work],
			[{ ...work, items: [...items, items[0] as SessionItem] }],
		);
		expect(grown).not.toBe(work);
	});
});
