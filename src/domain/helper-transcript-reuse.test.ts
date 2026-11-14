import { describe, expect, it } from "vitest";
import {
	type AgentTaskActivity,
	knownHelperRevisions,
	mergeAgentTaskActivity,
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
