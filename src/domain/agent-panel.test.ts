import { describe, expect, it } from "vitest";
import {
	activityPhrase,
	agentDoing,
	agentPanelRows,
	finishLineAnchorId,
	foldAgentRows,
	helperFinishedNote,
	helperIdentities,
	steeringSender,
} from "./agent-panel";
import { parseSteering, steeringTexts } from "./agent-steering";
import type { AgentTaskActivity } from "./child-task-activity";
import { SessionItemId } from "./ids";
import type { SessionItem } from "./session-item";

const sidekickBudget = {
	steps: 40,
	minutes: 20,
	tokens: 1,
	sidekick: { maxRounds: 6, roundTokens: 1, round: 1 },
} as never;

function task(
	id: string,
	overrides: Partial<AgentTaskActivity> & {
		role?: "writer" | "researcher" | "reviewer" | "checker";
		sidekick?: boolean;
	} = {},
): AgentTaskActivity {
	const { role = "writer", sidekick = false, ...rest } = overrides;
	return {
		id,
		parentSessionId: "root",
		title: `Task ${id}`,
		label: "Task 1",
		depth: 1,
		status: "working",
		prompt: "",
		placement: "fresh",
		access: "read_write",
		summary: null,
		harnessId: "api",
		listedModelId: null,
		createdAt: new Date(10_000).toISOString(),
		updatedAt: new Date(20_000).toISOString(),
		items: [],
		turnStatus: "running",
		subagent: {
			role,
			vm: "shared",
			steps: 0,
			minutes: 0,
			budget: sidekick ? sidekickBudget : null,
			spend: {} as never,
			subtree: {} as never,
		},
		...rest,
	};
}

const tool = (
	id: string,
	name: string,
	input: object,
	status: "inProgress" | "completed",
): SessionItem => ({
	kind: "dynamicToolCall",
	id: SessionItemId(id),
	tool: name,
	input: JSON.stringify(input),
	status,
});

describe("helper names and colours", () => {
	it("letters sidekicks, numbers several of a kind, keeps a lone kind plain, colours in start order", () => {
		const ids = helperIdentities([
			task("w2", { createdAt: "2026-10-21T10:03:00Z" }),
			task("s", { sidekick: true, createdAt: "2026-10-21T10:00:00Z" }),
			task("w1", { createdAt: "2026-10-21T10:01:00Z" }),
			task("r", { role: "researcher", createdAt: "2026-10-21T10:02:00Z" }),
		]);
		expect(ids.get("s")).toMatchObject({ name: "Sidekick A", color: "blue" });
		expect(ids.get("w1")).toMatchObject({ name: "Writer 1", color: "green" });
		expect(ids.get("r")).toMatchObject({ name: "Researcher", color: "amber" });
		expect(ids.get("w2")).toMatchObject({ name: "Writer 2", color: "violet" });
	});
});

describe("the live line under an agent's name", () => {
	it("falls back to the task title before the first activity", () => {
		expect(
			agentDoing({ status: "working", items: [], title: "Fix the export" }),
		).toBe("Fix the export");
	});
	it("follows the newest running step as items stream in", () => {
		const items: SessionItem[] = [
			tool("1", "bash", { command: "pnpm test" }, "completed"),
			tool("2", "edit", { path: "src/export.ts" }, "inProgress"),
		];
		expect(agentDoing({ status: "working", items, title: "t" })).toBe(
			"editing export.ts",
		);
		const later = [
			...items.slice(0, 1),
			{ ...items[1], status: "completed" } as SessionItem,
			tool("3", "bash", { command: "pnpm test" }, "inProgress"),
		];
		expect(agentDoing({ status: "working", items: later, title: "t" })).toBe(
			"running tests",
		);
		const reporting: SessionItem[] = [
			...later.slice(0, 2),
			{ ...later[2], status: "completed" } as SessionItem,
			{ kind: "agentMessage", id: SessionItemId("m"), text: "All green" },
		];
		expect(
			agentDoing({ status: "working", items: reporting, title: "t" }),
		).toBe("writing its report");
	});
	it("shows how a finished agent ended", () => {
		const items: SessionItem[] = [
			tool("1", "bash", { command: "pnpm test" }, "inProgress"),
		];
		expect(
			agentDoing({
				status: "done",
				items,
				title: "t",
				summary: "Tests pass, 3 files changed\n\nDetails…",
			}),
		).toBe("Tests pass, 3 files changed");
		expect(
			agentDoing({
				status: "failed",
				items: [
					{ kind: "error", id: SessionItemId("e"), message: "Budget used" },
				],
				title: "t",
			}),
		).toBe("failed: Budget used");
	});
	it("reads commands, files and searches as short verbs", () => {
		expect(
			activityPhrase({
				kind: "commandExecution",
				id: SessionItemId("c"),
				command: "git diff",
				cwd: null,
				status: "inProgress",
				output: null,
				exitCode: null,
			}),
		).toBe("inspecting changes");
		expect(
			activityPhrase(tool("r", "read", { path: "docs/api.md" }, "inProgress")),
		).toBe("reading api.md");
	});
});

describe("agents list rows", () => {
	const prompt = (id: string, at: number): SessionItem => ({
		kind: "userMessage",
		id: SessionItemId(id),
		text: id,
		timing: { startedAt: at },
	});
	it("lists the lead, then this request's helpers; earlier finished ones drop at the next message", () => {
		const old = task("old", {
			status: "done",
			turnStatus: "completed",
			createdAt: new Date(1_000).toISOString(),
			updatedAt: new Date(2_000).toISOString(),
		});
		const current = task("now", {
			role: "researcher",
			status: "done",
			turnStatus: "completed",
			createdAt: new Date(6_000).toISOString(),
			updatedAt: new Date(7_000).toISOString(),
		});
		const sidekick = task("sk", {
			sidekick: true,
			createdAt: new Date(1_500).toISOString(),
			queuedSteering: [{ id: "q", from: "parent", text: "Use the v2 API" }],
		});
		const rows = agentPanelRows({
			tasks: [old, current, sidekick],
			leadItems: [prompt("first", 500), prompt("second", 5_000)],
			leadTurnStatus: "running",
		});
		expect(rows.lead).toMatchObject({ name: "Lead", status: "working" });
		expect(rows.helpers.map((row) => row.name)).toEqual([
			"Sidekick A",
			"Researcher",
		]);
		expect(rows.helpers[0]).toMatchObject({ status: "working", queued: 1 });
		expect(rows.helpers[1]).toMatchObject({ status: "done" });
	});
	it("folds finished helpers into +N done when there are many, active first", () => {
		const row = (id: string, status: "working" | "done") =>
			({
				id,
				name: id,
				kind: "writer",
				color: "blue",
				status,
				doing: "",
				queued: 0,
				title: "",
			}) as const;
		const folded = foldAgentRows([
			row("a", "done"),
			row("b", "working"),
			row("c", "done"),
			row("d", "working"),
			row("e", "done"),
		]);
		expect(folded.shown.map((r) => r.id)).toEqual(["b", "d"]);
		expect(folded.folded.map((r) => r.id)).toEqual(["a", "c", "e"]);
		expect(
			foldAgentRows([row("a", "done"), row("b", "working")]).folded,
		).toEqual([]);
	});
	it("writes the finish note in one line", () => {
		expect(
			helperFinishedNote({
				name: "Sidekick A",
				status: "done",
				doing: "tests pass, 3 files changed",
			}),
		).toBe("Sidekick A finished: tests pass, 3 files changed");
		expect(
			helperFinishedNote({
				name: "Checker",
				status: "failed",
				doing: "failed",
			}),
		).toBe("Checker failed");
	});
	it("puts the finish line at the end of the turn it started in, before the answer", () => {
		const items: SessionItem[] = [
			prompt("p1", 1),
			tool("spawn", "agent", {}, "completed"),
			tool("t", "bash", { command: "ls" }, "completed"),
			{ kind: "agentMessage", id: SessionItemId("answer"), text: "Done" },
			prompt("p2", 2),
		];
		expect(finishLineAnchorId(items, SessionItemId("spawn"))).toBe("t");
		expect(finishLineAnchorId(items, undefined)).toBeUndefined();
	});
});

describe("steering messages", () => {
	it("round-trips who sent it and its words", () => {
		const fromLead = steeringTexts({
			sender: { kind: "parent", title: "Builder", id: "root" },
			message: "Use the v2 API",
			messageId: "m1",
		});
		expect(fromLead.text).toBe(
			"Message from Builder (root):\n\nUse the v2 API\n\nCoordination message ID: m1",
		);
		expect(parseSteering(fromLead.runtimeText)).toEqual({
			from: "parent",
			text: "Use the v2 API",
		});
		const fromUser = steeringTexts({
			sender: { kind: "user" },
			message: "Skip the docs",
			messageId: "m2",
		});
		expect(steeringSender(fromUser.runtimeText, "Lead")).toEqual({
			from: "You",
			text: "Skip the docs",
		});
		expect(steeringSender("Explore the parser", "Lead")).toEqual({
			from: "Lead",
			text: "Explore the parser",
		});
	});
});
