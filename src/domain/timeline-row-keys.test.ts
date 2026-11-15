import { describe, expect, it } from "vitest";
import { SessionItemId } from "./ids";
import type { SessionItem } from "./session-item";
import { groupTimelineRows, type TimelineRow } from "./timeline-activity";
import { timelineRowKeys } from "./timeline-row-keys";

const user = (id: string): SessionItem => ({
	kind: "userMessage",
	id: SessionItemId(id),
	text: id,
});
const answer = (id: string): SessionItem => ({
	kind: "agentMessage",
	id: SessionItemId(id),
	text: `answer ${id}`,
	phase: "final_answer",
});
const call = (id: string): SessionItem => ({
	kind: "dynamicToolCall",
	id: SessionItemId(id),
	tool: "bash",
	status: "completed",
});

/** Two long turns, as an agent writes them: the older one holds far more items than a page. */
const chat = [
	user("u1"),
	...Array.from({ length: 40 }, (_, index) => call(`a${index + 1}`)),
	answer("r1"),
	user("u2"),
	call("b1"),
	call("b2"),
	answer("r2"),
];
const at = (id: string) => chat.findIndex((item) => item.id === id);
const keysOf = (
	rows: readonly TimelineRow[],
	memory?: Parameters<typeof timelineRowKeys>[1],
) => timelineRowKeys(rows, memory);

describe("row keys across a page boundary inside a turn", () => {
	// The first page ends where a 200-item page ends: in the middle of turn 1.
	const firstPage = chat.slice(at("a21"));
	const whole = chat;

	it("shows why the list lost its place: the group's own name changes when older items join it", () => {
		const before = groupTimelineRows(firstPage, "idle").find(
			(row) => row.kind === "work",
		);
		const after = groupTimelineRows(whole, "idle").find(
			(row) => row.kind === "work",
		);
		expect(before?.kind === "work" && before.id).toBe("a21");
		expect(after?.kind === "work" && after.id).toBe("a1");
	});

	it("keeps the group's key when the older half of its turn is read", () => {
		const shown = groupTimelineRows(firstPage, "idle");
		const first = keysOf(shown);
		const joined = groupTimelineRows(whole, "idle");
		const next = keysOf(joined, first.memory);
		const groupBefore = shown.find((row) => row.kind === "work");
		const groupAfter = joined.find((row) => row.kind === "work");
		expect(first.keys.get(groupBefore as TimelineRow)).toBe("work:a21");
		// The reader's anchor row, still found by the same key.
		expect(next.keys.get(groupAfter as TimelineRow)).toBe("work:a21");
	});

	it("leaves the keys of every other row as they were, and never repeats one", () => {
		const shown = keysOf(groupTimelineRows(firstPage, "idle"));
		const joinedRows = groupTimelineRows(whole, "idle");
		const joined = keysOf(joinedRows, shown.memory);
		const all = joinedRows.map((row) => joined.keys.get(row));
		expect(new Set(all).size).toBe(all.length);
		// Items outside any group keep their own id.
		expect(all).toContain("r1");
		expect(all).toContain("u2");
		expect(all).toContain("r2");
	});

	it("keeps the key through a second older page too", () => {
		const third = chat.slice(at("a31"));
		const one = keysOf(groupTimelineRows(third, "idle"));
		const two = keysOf(groupTimelineRows(firstPage, "idle"), one.memory);
		const rows = groupTimelineRows(whole, "idle");
		const three = keysOf(rows, two.memory);
		expect(
			three.keys.get(rows.find((row) => row.kind === "work") as TimelineRow),
		).toBe("work:a31");
	});

	it("names a group by its first item when nothing was shown before", () => {
		const rows = groupTimelineRows(whole, "idle");
		const { keys } = keysOf(rows);
		expect(
			keys.get(rows.find((row) => row.kind === "work") as TimelineRow),
		).toBe("work:a1");
	});

	it("gives a second group a key of its own when a remembered key is already taken", () => {
		const items = [
			user("u1"),
			call("x1"),
			answer("r1"),
			user("u2"),
			call("y1"),
			answer("r2"),
		];
		const memory = new Map([
			[SessionItemId("x1"), "work:x1"],
			[SessionItemId("y1"), "work:x1"],
		]);
		const rows = groupTimelineRows(items, "idle");
		const { keys } = timelineRowKeys(rows, memory);
		const groups = rows.filter((row) => row.kind === "work");
		expect(groups.map((row) => keys.get(row))).toEqual(["work:x1", "work:y1"]);
	});
});
