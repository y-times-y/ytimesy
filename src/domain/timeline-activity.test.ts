import { describe, expect, it } from "vitest";
import { SessionItemId } from "./ids";
import type { SessionItem } from "./session-item";
import {
	explorationGroupIsLive,
	explorationLabel,
	groupTimelineRows,
	isExplorationItem,
} from "./timeline-activity";

function fileChange(id: string, path: string): SessionItem {
	return {
		kind: "fileChange",
		id: SessionItemId(id),
		status: "completed",
		changes: [
			{
				path,
				change: "update",
				additions: 1,
				deletions: 0,
				preview: "ok\n",
			},
		],
	};
}

const user = (id: string, text = id): SessionItem => ({
	kind: "userMessage",
	id: SessionItemId(id),
	text,
});
const answer = (id: string, text: string): SessionItem => ({
	kind: "agentMessage",
	id: SessionItemId(id),
	text,
});
const call = (id: string): SessionItem => ({
	kind: "dynamicToolCall",
	id: SessionItemId(id),
	tool: "bash",
	status: "completed",
});
const wake = (id: string): SessionItem =>
	user(id, `\u2063ytimesy-child-event:${id}`);

describe("push approval placement", () => {
	it("keeps approval cards above the final answer when a running turn finishes", () => {
		const approval: SessionItem = {
			kind: "pushApproval",
			id: SessionItemId("push-card"),
			requestId: "11111111-1111-4111-8111-111111111111",
			repo: "example/project",
			branch: "main",
			commits: 2,
			summary: "Fix the checkout",
		};
		const items = [
			user("request"),
			call("build"),
			approval,
			answer("final", "The push is waiting for approval."),
		];
		for (const status of ["running", "completed", "idle"] as const) {
			const rows = groupTimelineRows(items, status);
			const ids = rows.map((row) =>
				row.kind === "item" ? row.item.id : row.id,
			);
			expect(ids.filter((id) => id === approval.id)).toHaveLength(1);
			expect(ids.indexOf(approval.id)).toBeLessThan(
				ids.indexOf(SessionItemId("final")),
			);
		}
	});
});

describe("wake-up turns and question replies", () => {
	it("keeps Main's answer in view when a wake-up turn follows it", () => {
		const rows = groupTimelineRows(
			[
				user("ask"),
				call("spawn"),
				answer("a1", "This repo uses Vitest. A helper is writing the tests."),
				wake("e1"),
				call("check"),
				answer("a2", "The helper finished: 4 tests added."),
			],
			"completed",
		);
		expect(
			rows.map((row) => (row.kind === "item" ? row.item.id : row.kind)),
		).toEqual(["ask", "work", "a1", "work", "a2"]);
		// The hidden wake-up message shows no bubble.
		expect(
			rows.some((row) => row.kind === "item" && row.item.id === "e1"),
		).toBe(false);
	});
	it("ends the turn before a running wake-up turn", () => {
		const rows = groupTimelineRows(
			[
				user("ask"),
				call("bg"),
				answer("a1", "I'll let you know when the build finishes."),
				wake("exit"),
				call("read-log"),
			],
			"running",
		);
		expect(
			rows.map((row) => (row.kind === "item" ? row.item.id : row.kind)),
		).toEqual(["ask", "work", "a1", "read-log"]);
	});
	it("breaks an answer-only wake-up turn from the answer above it, and nothing else", () => {
		const ids = (items: SessionItem[], status: "completed" | "running") =>
			groupTimelineRows(items, status).map((row) =>
				row.kind === "item"
					? row.item.kind === "notice" && row.item.wake
						? `break:${row.item.id}`
						: row.item.id
					: row.kind,
			);
		expect(
			ids(
				[
					user("ask"),
					answer("a1", "391 PINEAPPLE"),
					wake("e1"),
					answer("a2", "The build passed."),
				],
				"completed",
			),
		).toEqual(["ask", "a1", "break:e1", "a2"]);
		// While it streams, too.
		expect(
			ids(
				[user("ask"), answer("a1", "391"), wake("e1"), answer("a2", "The")],
				"running",
			),
		).toEqual(["ask", "a1", "break:e1", "a2"]);
		// Its work row already separates it; a first turn has nothing above.
		expect(
			ids(
				[
					user("ask"),
					answer("a1", "x"),
					wake("e1"),
					call("c"),
					answer("a2", "y"),
				],
				"completed",
			),
		).toEqual(["ask", "a1", "work", "a2"]);
		expect(ids([wake("e1"), answer("a2", "y")], "completed")).toEqual(["a2"]);
		// The break is a silent notice, never the hidden message's bubble.
		const row = groupTimelineRows(
			[user("ask"), answer("a1", "x"), wake("e1"), answer("a2", "y")],
			"completed",
		)[2];
		expect(row).toMatchObject({
			kind: "item",
			item: { kind: "notice", wake: true, message: "" },
		});
	});
	it("shows a question card's reply once, in the card", () => {
		const rows = groupTimelineRows(
			[
				user("ask"),
				{
					kind: "userQuestion",
					id: SessionItemId("q"),
					questions: [],
				},
				user("reply", "Use Postgres"),
				answer("a", "Postgres it is."),
			],
			"completed",
		);
		const ids = rows.map((row) =>
			row.kind === "item" ? row.item.id : row.kind,
		);
		expect(ids).toContain("q");
		expect(ids).not.toContain("reply");
		expect(ids).toContain("a");
	});
});

describe("timeline activity grouping", () => {
	it("keeps explicit commentary inside work when a turn fails without an answer", () => {
		const rows = groupTimelineRows(
			[
				{
					kind: "agentMessage",
					id: SessionItemId("comment"),
					phase: "commentary",
					text: "Checking",
				},
				{ kind: "error", id: SessionItemId("error"), message: "Disconnected" },
			],
			"failed",
		);
		expect(rows[0]).toMatchObject({
			kind: "work",
			items: [{ text: "Checking" }],
		});
		expect(rows[1]).toMatchObject({ kind: "item", item: { kind: "error" } });
	});
	it("groups the whole previous turn without reopening it for a new prompt", () => {
		const command: SessionItem = {
			kind: "commandExecution",
			id: SessionItemId("cmd"),
			command: "pnpm test",
			cwd: null,
			status: "completed",
			output: "ok",
			exitCode: 0,
		};
		const rows = groupTimelineRows([
			{ kind: "reasoning", id: SessionItemId("r"), summaries: ["Checking"] },
			command,
			{ kind: "agentMessage", id: SessionItemId("a"), text: "Update" },
			{
				...command,
				id: SessionItemId("failed"),
				status: "failed",
				exitCode: 1,
			},
			{ kind: "userMessage", id: SessionItemId("u"), text: "Next" },
			{ ...command, id: SessionItemId("next") },
		]);
		expect(rows.map((row) => row.kind)).toEqual([
			"work",
			"item",
			"item",
			"item",
		]);
		expect(rows[0]).toMatchObject({
			id: "r",
			items: [
				{ kind: "reasoning" },
				{ kind: "commandExecution" },
				{ status: "failed" },
			],
		});
		expect(rows[1]).toMatchObject({ kind: "item", item: { text: "Update" } });
	});
	it("treats file reads and searches as exploration, not shell pills", () => {
		const read: SessionItem = {
			kind: "dynamicToolCall",
			id: SessionItemId("read-1"),
			tool: "read_file",
			status: "completed",
		};
		const search: SessionItem = {
			kind: "webSearch",
			id: SessionItemId("web-1"),
			query: "agent-browser",
		};
		const shell: SessionItem = {
			kind: "commandExecution",
			id: SessionItemId("cmd-1"),
			command: "ls",
			cwd: "/tmp",
			status: "completed",
			output: null,
			exitCode: 0,
		};
		expect(isExplorationItem(read)).toBe(true);
		expect(isExplorationItem(search)).toBe(true);
		expect(isExplorationItem(shell)).toBe(false);
	});

	it("collapses consecutive reads and searches into one Explored row", () => {
		const items: SessionItem[] = [
			{
				kind: "dynamicToolCall",
				id: SessionItemId("read-1"),
				tool: "read_file",
				status: "completed",
			},
			{
				kind: "dynamicToolCall",
				id: SessionItemId("read-2"),
				tool: "read",
				status: "completed",
			},
			{
				kind: "webSearch",
				id: SessionItemId("s1"),
				query: "layout",
			},
			{
				kind: "commandExecution",
				id: SessionItemId("cmd-1"),
				command: "pnpm test",
				cwd: "/tmp",
				status: "inProgress",
				output: null,
				exitCode: null,
			},
			{
				kind: "dynamicToolCall",
				id: SessionItemId("read-3"),
				tool: "view",
				status: "completed",
			},
		];
		const rows = groupTimelineRows(items);
		expect(rows).toHaveLength(3);
		expect(rows[0]).toMatchObject({
			kind: "exploration",
			counts: { files: 2, searches: 1 },
		});
		expect(explorationLabel({ files: 2, searches: 1 })).toBe(
			"Explored 2 files 1 search",
		);
		expect(rows[1]).toMatchObject({
			kind: "item",
			item: { kind: "commandExecution" },
		});
		expect(rows[2]).toMatchObject({
			kind: "exploration",
			counts: { files: 1, searches: 0 },
		});
		expect(explorationLabel({ files: 1, searches: 0 })).toBe("Explored 1 file");
	});

	it("streams an in-progress read into Explored and marks that group live", () => {
		const rows = groupTimelineRows([
			{
				kind: "dynamicToolCall",
				id: SessionItemId("read-1"),
				tool: "read_file",
				status: "completed",
			},
			{
				kind: "dynamicToolCall",
				id: SessionItemId("read-2"),
				tool: "read session-timeline.tsx",
				status: "inProgress",
			},
		]);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			kind: "exploration",
			counts: { files: 2, searches: 0 },
		});
		if (rows[0]?.kind !== "exploration") {
			throw new Error("expected one Explored group");
		}
		expect(explorationGroupIsLive(rows[0].items)).toBe(true);
		expect(explorationGroupIsLive(rows[0].items.slice(0, 1))).toBe(false);
	});

	it("keeps file edits as coding activity instead of Explored", () => {
		expect(isExplorationItem(fileChange("f1", "src/a.ts"))).toBe(false);
		const rows = groupTimelineRows([
			fileChange("f1", "src/a.ts"),
			{
				kind: "dynamicToolCall",
				id: SessionItemId("read-1"),
				tool: "read_file",
				status: "completed",
			},
			fileChange("f2", "src/b.ts"),
		]);
		expect(rows.map((row) => row.kind)).toEqual([
			"item",
			"exploration",
			"item",
		]);
		expect(rows[0]).toMatchObject({
			kind: "item",
			item: { kind: "fileChange" },
		});
		expect(rows[2]).toMatchObject({
			kind: "item",
			item: { kind: "fileChange" },
		});
	});
});

it("keeps a proposed plan out of the collapsed work of a finished turn", () => {
	const rows = groupTimelineRows(
		[
			{ kind: "userMessage", id: SessionItemId("u1"), text: "Rework billing" },
			{
				kind: "dynamicToolCall",
				id: SessionItemId("t1:enter"),
				tool: "enter_plan_mode",
				status: "completed",
			},
			{
				kind: "planProposal",
				id: SessionItemId("t1:plan"),
				text: "1. Split invoices",
			},
		],
		"completed",
	);
	expect(
		rows.map((row) => (row.kind === "item" ? row.item.kind : row.kind)),
	).toEqual(["userMessage", "work", "planProposal"]);
});

it("keeps a model switch in view above the answer of a finished turn", () => {
	const rows = groupTimelineRows(
		[
			{ kind: "userMessage", id: SessionItemId("u1"), text: "Fix the test" },
			{
				kind: "dynamicToolCall",
				id: SessionItemId("t1:read"),
				tool: "read_file",
				status: "completed",
			},
			{
				kind: "modelSwitch",
				id: SessionItemId("t1:switch-1"),
				message:
					"Codex is unavailable (outage); continued on GPT-6.1 Sol via OpenRouter.",
				reason: "outage",
				from: { model: "GPT-6.1-Sol", connection: "Codex" },
				to: {
					model: "GPT-6.1 Sol",
					connection: "OpenRouter",
					key: "11111111-1111-4111-8111-111111111111|openai/gpt-6.1-sol",
				},
				state: "switched",
			},
			{ kind: "agentMessage", id: SessionItemId("t1:answer"), text: "Fixed." },
		],
		"completed",
	);
	expect(
		rows.map((row) => (row.kind === "item" ? row.item.kind : row.kind)),
	).toEqual(["userMessage", "work", "modelSwitch", "agentMessage"]);
});

it("shows a continued chat's handoff as its own card before the first turn", () => {
	const handoff = {
		kind: "handoff" as const,
		id: SessionItemId("handoff-1"),
		tool: "claude" as const,
		title: "Fix login",
		turns: 42,
		at: "2026-10-31T00:00:00Z",
		context: "…",
	};
	const rows = groupTimelineRows(
		[
			handoff,
			{ kind: "userMessage", id: SessionItemId("u1"), text: "Go on." },
			{ kind: "agentMessage", id: SessionItemId("a1"), text: "Done." },
		],
		"completed",
	);
	expect(
		rows.map((row) => (row.kind === "item" ? row.item.kind : row.kind)),
	).toEqual(["handoff", "userMessage", "agentMessage"]);
	expect(groupTimelineRows([handoff], "idle")).toEqual([
		{ kind: "item", item: handoff },
	]);
});
