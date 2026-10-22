import { describe, expect, it } from "vitest";
import { helperFinishAnchors } from "./helper-finish-placement";
import { SessionItemId } from "./ids";
import type { SessionItem } from "./session-item";
import { groupTimelineRows } from "./timeline-activity";

function prompt(id: string, startedAt: number, completedAt?: number) {
	return {
		kind: "userMessage",
		id: SessionItemId(id),
		text: id,
		timing: { startedAt, ...(completedAt ? { completedAt } : {}) },
	} satisfies SessionItem;
}
function wake(id: string, startedAt: number, completedAt?: number) {
	return {
		kind: "notice",
		id: SessionItemId(id),
		message: "",
		wake: true,
		timing: { startedAt, ...(completedAt ? { completedAt } : {}) },
	} satisfies SessionItem;
}
function spawn(id: string, input: object = {}) {
	return {
		kind: "dynamicToolCall",
		id: SessionItemId(id),
		tool: "agent",
		input: JSON.stringify(input),
		status: "completed",
	} satisfies SessionItem;
}
function bash(id: string) {
	return {
		kind: "commandExecution",
		id: SessionItemId(id),
		command: "cat r",
		status: "completed",
	} as unknown as SessionItem;
}
function answer(id: string) {
	return {
		kind: "agentMessage",
		id: SessionItemId(id),
		text: id,
	} satisfies SessionItem;
}

function place(
	items: SessionItem[],
	helpers: { id: string; start: string; finishedAt?: number }[],
	options: { running?: boolean; reportsWake?: boolean } = {},
) {
	const anchors = helperFinishAnchors({
		items,
		rows: groupTimelineRows(items, options.running ? "running" : "completed"),
		reportsWake: options.reportsWake ?? true,
		helpers: helpers.map((helper) => ({
			id: helper.id,
			start: SessionItemId(helper.start),
			finishedAt: helper.finishedAt,
		})),
	});
	return Object.fromEntries(anchors);
}

// Main starts three helpers and ends its turn; each report wakes it in a
// turn of its own, and its reply follows.
const started = [
	prompt("p1", 0, 100),
	spawn("s1"),
	spawn("s2"),
	spawn("s3"),
	answer("started"),
];
const helpers = [
	{ id: "research-1", start: "s1", finishedAt: 290 },
	{ id: "research-2", start: "s2", finishedAt: 190 },
	{ id: "build-1", start: "s3", finishedAt: 395 },
];

describe("where a helper's finish card goes", () => {
	it("opens the wake-up turn its report started, above Main's reply to it", () => {
		const items = [
			...started,
			wake("w1", 200, 210),
			answer("reply-research-2"),
			wake("w2", 300, 310),
			answer("reply-research-1"),
			wake("w3", 400, 420),
			bash("check"),
			answer("reply-build-1"),
		];
		expect(place(items, helpers)).toEqual({
			// An answer-first wake-up turn keeps its break row; the card follows it.
			"research-2": "w1",
			"research-1": "w2",
			// A turn with work opens under the reply before it.
			"build-1": "reply-research-1",
		});
	});
	it("goes last until its wake-up turn starts, then stays in the same place", () => {
		// Main still streaming its first answer; research-2 finished meanwhile.
		const streaming = started;
		expect(place(streaming, helpers.slice(1, 2), { running: true })).toEqual({
			"research-2": null,
		});
		// Turn ended, report not delivered yet: still last.
		expect(place(started, helpers.slice(1, 2))).toEqual({ "research-2": null });
		// The wake-up turn started: under Main's answer, where it already was.
		const woke = [...started, wake("w1", 200)];
		expect(place(woke, helpers.slice(1, 2), { running: true })).toEqual({
			"research-2": "started",
		});
		// A later report waits last while an earlier one's turn runs.
		expect(place(woke, helpers.slice(0, 2), { running: true })).toEqual({
			"research-2": "started",
			"research-1": null,
		});
	});
	it("keeps a reader that was waited for before the answer of its turn", () => {
		const items = [
			prompt("p1", 0, 100),
			spawn("s1", { wait: true }),
			bash("after"),
			answer("done"),
		];
		expect(place(items, [{ id: "r", start: "s1", finishedAt: 50 }])).toEqual({
			r: "after",
		});
	});
	it("in a helper's view, puts a report that arrived mid-turn before that turn's answer", () => {
		const items = [
			prompt("p1", 0, 100),
			spawn("s1"),
			bash("after"),
			answer("done"),
		];
		const helper = [{ id: "r", start: "s1", finishedAt: 50 }];
		expect(place(items, helper, { reportsWake: false })).toEqual({
			r: "after",
		});
		// Finished after that turn ended: its wake-up turn is still to come.
		expect(
			place(items, [{ ...helper[0], finishedAt: 150 }], { reportsWake: false }),
		).toEqual({ r: null });
	});
	it("goes last when its start is unknown", () => {
		expect(
			place(started, [{ id: "x", start: "missing", finishedAt: 1 }]),
		).toEqual({ x: null });
	});
});
