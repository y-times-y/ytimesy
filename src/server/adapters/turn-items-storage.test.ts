import { describe, expect, it } from "vitest";
import type { SessionItem } from "#/domain/session-item";
import {
	newTurnItemsColumn,
	planItemsWrite,
	rebaseAfterWrite,
} from "./turn-items-storage";

const user = (id: string): SessionItem =>
	({ kind: "userMessage", id, text: id }) as SessionItem;
const note = (id: string): SessionItem =>
	({ kind: "notice", id, text: id }) as unknown as SessionItem;

describe("turn items storage", () => {
	it("records the turn's first item", () => {
		expect(newTurnItemsColumn([user("u1"), note("n"), user("u2")])).toBe(
			'{"from":"u2"}',
		);
		expect(newTurnItemsColumn([note("n")])).toBeNull();
	});

	it("writes the full list for a legacy turn", () => {
		const items = [user("u1")];
		const write = planItemsWrite({ items }, items, 4, "s.items");
		expect(write.apiTurn).toBe("$4");
		expect(write.session).toBe("$4");
		expect(write.extra).toEqual([]);
	});

	it("sends only the turn's items when earlier ones are unchanged", () => {
		const loaded = [user("u1"), note("a"), user("u2")];
		const items = [...loaded, note("b")];
		const write = planItemsWrite(
			{ items: loaded, items_from: "u2" },
			items,
			4,
			"s.items",
		);
		expect(JSON.parse(write.itemsText).map((i: SessionItem) => i.id)).toEqual([
			"u2",
			"b",
		]);
		expect(write.apiTurn).toBe("items");
		expect(write.extra).toEqual(["u2"]);
		expect(write.session).toContain("$5");
	});

	it("binds the first item's id where the statement says", () => {
		const loaded = [user("u1"), user("u2")];
		const write = planItemsWrite(
			{ items: loaded, items_from: "u2" },
			[...loaded, note("b")],
			4,
			"s.items",
			6,
		);
		expect(write.session).toContain("$6");
		expect(write.session).not.toContain("$5");
	});

	it("sends everything when an earlier item changed", () => {
		const loaded = [user("u1"), user("u2")];
		const items = [note("changed"), user("u2")];
		const write = planItemsWrite(
			{ items: loaded, items_from: "u2" },
			items,
			4,
			"s.items",
		);
		expect(write.session).toBe("$4");
		expect(write.extra).toEqual([]);
		expect(JSON.parse(write.itemsText)).toHaveLength(2);
	});

	it("after one whole-history write the next writes send only the turn's items again", () => {
		const turn = { items: [user("u1"), user("u2")], items_from: "u2" };
		const items = [note("changed"), user("u2")];
		const first = planItemsWrite(turn, items, 4, "s.items");
		expect(first.rewroteHistory).toBe(true);
		rebaseAfterWrite(turn, items, first);
		const next = [...items, note("n3")];
		const second = planItemsWrite(turn, next, 4, "s.items");
		expect(second.rewroteHistory).toBeUndefined();
		expect(JSON.parse(second.itemsText)).toHaveLength(2);
		// A partial write leaves the baseline alone.
		const before = turn.items;
		rebaseAfterWrite(turn, next, second);
		expect(turn.items).toBe(before);
	});
});
