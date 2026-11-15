import { describe, expect, it } from "vitest";
import {
	type AgentTaskActivity,
	applyItemsDelta,
	knownHelperRevisions,
	mergeAgentTaskActivity,
	publicItemsWithPositions,
	reusableHelperIds,
} from "./child-task-activity";

const helper = (id: string, parent: string, live = false) => ({
	id,
	parentSessionId: parent,
	live,
});

describe("reusableHelperIds", () => {
	const helpers = [
		helper("a", "root"),
		helper("a1", "a"),
		helper("b", "root"),
		helper("c", "root", true),
	];
	const revisions = new Map([
		["a", "5"],
		["a1", "3"],
		["b", "7"],
		["c", "9"],
	]);

	it("reuses finished helpers the browser holds at their current revision", () => {
		const reused = reusableHelperIds("root", helpers, revisions, {
			a: "5",
			a1: "3",
			b: "7",
			c: "9",
		});
		expect([...reused].sort()).toEqual(["a", "a1", "b"]);
	});

	it("never reuses a working helper", () => {
		const reused = reusableHelperIds("root", helpers, revisions, { c: "9" });
		expect(reused.has("c")).toBe(false);
	});

	it("reads a whole subtree again when any helper in it changed", () => {
		// a's spend sums a1's: a1 moving on means a is read again too.
		const reused = reusableHelperIds("root", helpers, revisions, {
			a: "5",
			a1: "2",
			b: "7",
		});
		expect([...reused]).toEqual(["b"]);
	});

	it("reuses nothing the browser does not hold", () => {
		expect(reusableHelperIds("root", helpers, revisions, {}).size).toBe(0);
	});
});

const task = (
	id: string,
	extra: Partial<AgentTaskActivity> = {},
): AgentTaskActivity =>
	({
		id,
		parentSessionId: "root",
		title: id,
		label: "1",
		depth: 1,
		status: "completed",
		prompt: "",
		placement: "fresh",
		access: "read_write",
		summary: null,
		harnessId: "codex",
		listedModelId: null,
		createdAt: "2026-11-14T00:00:00Z",
		updatedAt: "2026-11-14T00:00:00Z",
		items: [],
		turnStatus: "completed",
		...extra,
	}) as AgentTaskActivity;

describe("mergeAgentTaskActivity", () => {
	const items = [{ kind: "agentMessage", id: "m", text: "done" }] as never;

	it("keeps the browser's transcript for helpers the server left out", () => {
		const held = [
			task("a", { items, itemsRev: "5", subagent: { steps: 3 } as never }),
		];
		const merged = mergeAgentTaskActivity(held, [
			task("a", { itemsRev: "5", unchanged: true, title: "renamed" }),
		]);
		expect(merged?.[0]).toMatchObject({
			items,
			title: "renamed",
			subagent: { steps: 3 },
		});
		expect(merged?.[0]?.unchanged).toBeUndefined();
	});

	it("asks for a full read when it no longer holds a left-out helper", () => {
		expect(
			mergeAgentTaskActivity([], [task("a", { unchanged: true })]),
		).toBeNull();
	});

	it("sends back only revisions of transcripts it holds", () => {
		expect(
			knownHelperRevisions([
				task("a", { itemsRev: "5" }),
				task("b"),
				task("c", { itemsRev: "2", unchanged: true }),
			]),
		).toEqual({ a: "5" });
	});
});

describe("helper transcript deltas", () => {
	const msg = (id: string, text = id) =>
		({ kind: "agentMessage", id, text }) as never;
	const hidden = (id: string) =>
		({
			kind: "agentMessage",
			id,
			text: "⁣ytimesy-child-event:abc",
		}) as never;

	it("numbers the shown items by stored position, skipping the ones the view drops", () => {
		const shown = publicItemsWithPositions([msg("a"), hidden("h"), msg("b")]);
		expect(shown.positions).toEqual([0, 2]);
		expect(shown.items.map((item) => item.id)).toEqual(["a", "b"]);
	});

	it("applies changed rows: an edit, an append, a row the view drops and a shorter transcript", () => {
		const held = { items: [msg("a"), msg("b")], positions: [0, 2] };
		const applied = applyItemsDelta(held, {
			base: "5",
			count: 5,
			rows: [
				{ position: 2, item: msg("b", "edited") },
				{ position: 3, item: null },
				{ position: 4, item: msg("e") },
			],
		});
		expect(applied?.positions).toEqual([0, 2, 4]);
		expect(
			applied?.items.map((item) => (item as { text: string }).text),
		).toEqual(["a", "edited", "e"]);
		// The transcript shrank: rows past its length are gone.
		expect(
			applyItemsDelta(held, { base: "5", count: 1, rows: [] })?.positions,
		).toEqual([0]);
		// A row past the transcript, or positions that do not match the items.
		expect(
			applyItemsDelta(held, {
				base: "5",
				count: 2,
				rows: [{ position: 7, item: msg("x") }],
			}),
		).toBeNull();
		expect(
			applyItemsDelta(
				{ items: [msg("a")], positions: [] },
				{ base: "5", count: 1, rows: [] },
			),
		).toBeNull();
	});

	it("merges a delta only on top of the revision it was made from, keeping spend and context use", () => {
		const items = [msg("a"), msg("b")];
		const held = [
			task("h", {
				items,
				itemsRev: "5",
				itemPositions: [0, 1],
				subagent: { steps: 4 } as never,
				contextUsage: { context: { used: 1, limit: 2 } } as never,
			}),
		];
		const delta = task("h", {
			itemsRev: "6",
			turnStatus: "running",
			itemsDelta: {
				base: "5",
				count: 3,
				rows: [{ position: 2, item: msg("c") }],
			},
		});
		const merged = mergeAgentTaskActivity(held, [delta]);
		expect(merged?.[0]).toMatchObject({
			itemsRev: "6",
			itemPositions: [0, 1, 2],
			subagent: { steps: 4 },
			contextUsage: { context: { used: 1, limit: 2 } },
		});
		expect(merged?.[0]?.items.map((item) => item.id)).toEqual(["a", "b", "c"]);
		expect(merged?.[0]?.itemsDelta).toBeUndefined();
		// The page's copy moved on (or never had positions): read whole.
		expect(
			mergeAgentTaskActivity([{ ...held[0], itemsRev: "4" } as never], [delta]),
		).toBeNull();
		expect(
			mergeAgentTaskActivity(
				[{ ...held[0], itemPositions: undefined } as never],
				[delta],
			),
		).toBeNull();
		expect(mergeAgentTaskActivity([], [delta])).toBeNull();
	});
});
