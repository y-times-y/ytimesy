import { describe, expect, it } from "vitest";
import {
	activityPhrase,
	agentDoing,
	agentPanelRows,
	backgroundPollMs,
	backgroundReadChatIds,
	backgroundRows,
	backgroundRunsFromReadModel,
	finishLineAnchorId,
	foldAgentRows,
	formatElapsed,
	formatTokens,
	helperFinishCard,
	helperIdentities,
	helperMetric,
	leadMetric,
	metricDetail,
	metricText,
	steeringSender,
} from "./agent-panel";
import { parseSteering, steeringTexts } from "./agent-steering";
import type { AgentTaskActivity } from "./child-task-activity";
import { helperCallLabel } from "./helper-names";
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

describe("helper names, icons and colours", () => {
	it("names each helper by its kind and number, coloured in start order", () => {
		const ids = helperIdentities([
			task("w2", {
				title: "Write the release notes",
				createdAt: "2026-10-21T10:03:00Z",
			}),
			task("s", {
				title: "Build the CSV export",
				sidekick: true,
				createdAt: "2026-10-21T10:00:00Z",
			}),
			task("w1", {
				title: "Fix the rounding bug",
				createdAt: "2026-10-21T10:01:00Z",
			}),
			task("r", {
				role: "researcher",
				title: "Trace dashboard totals",
				createdAt: "2026-10-21T10:02:00Z",
			}),
			task("v", {
				role: "checker",
				title: "Verify the export",
				createdAt: "2026-10-21T10:04:00Z",
			}),
			task("r2", {
				role: "researcher",
				title: "Read the docs",
				createdAt: "2026-10-21T10:05:00Z",
			}),
		]);
		expect(ids.get("s")).toMatchObject({
			name: "build-1",
			task: "Build the CSV export",
			icon: "hammer",
			color: "#FF8F96",
		});
		// A sidekick and a writer are both Build helpers, numbered together.
		expect(ids.get("w1")).toMatchObject({ name: "build-2", color: "#9CD242" });
		expect(ids.get("r")).toMatchObject({
			name: "research-1",
			icon: "search",
			color: "#83C1FF",
		});
		expect(ids.get("w2")).toMatchObject({ name: "build-3", color: "#FF9D62" });
		expect(ids.get("v")).toMatchObject({
			name: "verify-1",
			icon: "circle-check",
			color: "#E0BA31",
		});
		// The sixth takes a paler red, not the first's.
		expect(ids.get("r2")).toMatchObject({
			name: "research-2",
			color: "#FFC1C5",
		});
	});
	it("keeps a helper's name and colour when another finishes or starts", () => {
		const first = task("a", { createdAt: "2026-10-21T10:00:00Z" });
		const second = task("b", {
			role: "reviewer",
			createdAt: "2026-10-21T10:01:00Z",
		});
		const before = helperIdentities([first, second]).get("b");
		const after = helperIdentities([
			task("a", {
				createdAt: "2026-10-21T10:00:00Z",
				status: "done",
				turnStatus: "completed",
			}),
			second,
			task("c", { createdAt: "2026-10-21T10:02:00Z" }),
		]).get("b");
		expect(after).toEqual(before);
		expect(after).toMatchObject({ name: "review-1", color: "#9CD242" });
	});
});

describe("time and tokens", () => {
	it("formats elapsed time and compact token counts", () => {
		expect(formatElapsed(45_000)).toBe("45s");
		expect(formatElapsed(125_000)).toBe("2m 05s");
		expect(formatElapsed(3_840_000)).toBe("1h 04m");
		expect(formatTokens(850)).toBe("850");
		expect(formatTokens(9_200)).toBe("9k");
		expect(formatTokens(21_400)).toBe("21k");
		expect(formatTokens(1_230_000)).toBe("1.2M");
	});
	it("counts a running agent from its start and a finished one by its duration", () => {
		const metric = {
			startedAt: 0,
			tokens: {
				input: 18_000,
				output: 3_000,
				costUsd: 0.042,
				estimated: false,
			},
		};
		expect(metricText(metric, 125_000)).toBe("2m 05s · 21k tokens");
		expect(metricText({ ...metric, endedAt: 60_000 }, 999_999)).toBe(
			"1m 00s · 21k tokens",
		);
		expect(metricText({ startedAt: 0 }, 5_000)).toBe("5s");
		// A helper starting has counted none yet: no "0 tokens".
		const none = { ...metric.tokens, input: 0, output: 0 };
		expect(metricText({ startedAt: 0, tokens: none }, 5_000)).toBe("5s");
		expect(metricDetail(metric)).toBe("18k in · 3k out · $0.04");
		expect(
			metricDetail({ ...metric, tokens: { ...metric.tokens, cached: 12_000 } }),
		).toBe("18k in · 12k cached · 3k out · $0.04");
		expect(
			metricDetail({ ...metric, tokens: { ...metric.tokens, costUsd: null } }),
		).toBe("18k in · 3k out · cost unknown");
	});
	it("takes a helper's tokens from its spend and a sidekick's time from its round", () => {
		const spend = {
			tokens: 21_000,
			inputTokens: 18_000,
			outputTokens: 3_000,
			costUsd: 0.04,
			planBilled: true,
		} as never;
		const helper = task("s", {
			sidekick: true,
			createdAt: "2026-10-21T10:00:00Z",
			updatedAt: "2026-10-21T10:30:00Z",
			status: "done",
			subagent: {
				role: "writer",
				vm: "shared",
				steps: 1,
				minutes: 1,
				budget: {
					sidekick: { roundStartedAt: "2026-10-21T10:20:00Z" },
				} as never,
				spend,
				subtree: spend,
			},
		});
		expect(helperMetric(helper)).toEqual({
			startedAt: Date.parse("2026-10-21T10:20:00Z"),
			endedAt: Date.parse("2026-10-21T10:30:00Z"),
			tokens: {
				input: 18_000,
				output: 3_000,
				costUsd: 0.04,
				estimated: true,
			},
		});
	});
	it("ends a finished helper's time at its turn's recorded end, not its row's later updates", () => {
		const failed = task("f", {
			status: "failed",
			turnStatus: "failed",
			createdAt: new Date(10_000).toISOString(),
			updatedAt: new Date(68_000).toISOString(),
			items: [
				{
					kind: "userMessage",
					id: SessionItemId("brief"),
					text: "brief",
					timing: { startedAt: 10_000, completedAt: 14_000 },
				},
			],
		});
		expect(helperMetric(failed)).toMatchObject({
			startedAt: 10_000,
			endedAt: 14_000,
		});
	});
	it("stops Main's clock when its turn ended, also while helpers still work", () => {
		const items: SessionItem[] = [
			{
				kind: "userMessage",
				id: SessionItemId("ask"),
				text: "ask",
				timing: { startedAt: 1_000, completedAt: 61_000 },
			},
		];
		const rows = agentPanelRows({
			tasks: [task("sk")],
			leadItems: items,
			leadTurnStatus: "completed",
		});
		expect(rows.lead.status).toBe("free");
		expect(rows.lead.metric).toMatchObject({
			startedAt: 1_000,
			endedAt: 61_000,
		});
		expect(metricText(rows.lead.metric as never, 10_000_000)).toBe("1m 00s");
		// A wake-up turn since then ends it later.
		const woken = leadMetric({
			turnStatus: "completed",
			items: [
				...items,
				{
					kind: "userMessage",
					id: SessionItemId("wake"),
					text: "\u2063ytimesy-child-event:e1",
					timing: { startedAt: 90_000, completedAt: 120_000 },
				},
			],
		});
		expect(woken).toMatchObject({ startedAt: 1_000, endedAt: 120_000 });
	});
	it("shows no running clock for a finished turn whose end was not recorded", () => {
		const metric = leadMetric({
			turnStatus: "completed",
			items: [
				{
					kind: "userMessage",
					id: SessionItemId("old"),
					text: "old",
					timing: { startedAt: 1_000 },
					apiUsage: {
						inputTokens: 40_000,
						outputTokens: 7_000,
						uncachedInputTokens: null,
						cacheReadTokens: null,
						cacheWriteTokens: null,
					},
				},
			],
		});
		expect(metric?.untimed).toBe(true);
		expect(metricText(metric as never, 10_000_000)).toBe("47k tokens");
	});
	it("gives Main the latest request's time and tokens", () => {
		const metric = leadMetric({
			turnStatus: "running",
			items: [
				{
					kind: "userMessage",
					id: SessionItemId("old"),
					text: "old",
					timing: { startedAt: 1 },
					apiUsage: {
						inputTokens: 9e6,
						outputTokens: 0,
						uncachedInputTokens: null,
						cacheReadTokens: null,
						cacheWriteTokens: null,
					},
				},
				{
					kind: "userMessage",
					id: SessionItemId("new"),
					text: "new",
					timing: { startedAt: 5_000 },
					apiUsage: {
						inputTokens: 4_000,
						outputTokens: 600,
						uncachedInputTokens: null,
						cacheReadTokens: null,
						cacheWriteTokens: null,
						costUsd: 0.01,
					},
				},
			],
		});
		expect(metric).toMatchObject({
			startedAt: 5_000,
			tokens: { input: 4_000, output: 600 },
		});
		expect(metric?.endedAt).toBeUndefined();
	});
});

describe("background commands", () => {
	it("are named by what they run, with live status and time only", () => {
		const rows = backgroundRows([
			{
				id: "1",
				command: "pnpm dev --port 3000",
				status: "running",
				startedAt: 0,
			},
			{
				id: "2",
				command: "pnpm vitest run",
				status: "exited",
				exitCode: 0,
				startedAt: 0,
				endedAt: 9_000,
			},
			{
				id: "3",
				command: "./scripts/seed.sh",
				status: "failed",
				startedAt: 0,
				endedAt: 1_000,
			},
		]);
		expect(
			rows.map((row) => [row.name, row.doing, row.doingDetail, row.tag]),
		).toEqual([
			["dev server", "pnpm dev --port 3000", undefined, "Background"],
			["test suite", "Exited 0", "pnpm vitest run", "Background"],
			["seed.sh", "Failed", "./scripts/seed.sh", "Background"],
		]);
		expect(rows[0]?.metric?.tokens).toBeUndefined();
		expect(rows[0]?.messageable).toBe(false);
	});
});

describe("the background commands read model", () => {
	it("lists each running command once, oldest first, named by what it runs", () => {
		const runs = backgroundRunsFromReadModel({
			main: [
				{
					id: "b",
					label: "pnpm vitest --watch",
					startedAt: 20,
					status: "running",
				},
			],
			helper: [
				{
					id: "a",
					label: "pnpm dev --port 3000",
					startedAt: 10,
					status: "running",
				},
				{
					id: "b",
					label: "pnpm vitest --watch",
					startedAt: 20,
					status: "running",
				},
			],
		});
		expect(runs.map((run) => run.id)).toEqual(["a", "b"]);
		expect(
			agentPanelRows({
				tasks: [],
				leadItems: [],
				leadTurnStatus: "completed",
				background: runs,
			}).background.map((row) => [row.name, row.tag, row.status]),
		).toEqual([
			["dev server", "Background", "working"],
			["test suite", "Background", "working"],
		]);
	});

	it("reads the chat and its newest helpers, at most 20", () => {
		expect(backgroundReadChatIds(undefined, [])).toEqual([]);
		const helpers = Array.from({ length: 25 }, (_, index) => ({
			id: `h${index}`,
			createdAt: new Date(index * 1000).toISOString(),
		}));
		const ids = backgroundReadChatIds("main", helpers);
		expect(ids).toHaveLength(20);
		expect(ids.slice(0, 2)).toEqual(["main", "h24"]);
	});

	it("polls while agents work or commands run, not when nothing runs", () => {
		expect(backgroundPollMs({ agentsWorking: true, running: 0 })).toBe(5_000);
		// Between turns the read is what opens the stream for the exit's wake-up turn.
		expect(backgroundPollMs({ agentsWorking: false, running: 1 })).toBe(5_000);
		expect(backgroundPollMs({ agentsWorking: false, running: 0 })).toBe(false);
	});
});

describe("the live line under an agent's name", () => {
	it("falls back to the given title (empty for helpers, named by their task) before the first activity", () => {
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
		expect(rows.lead).toMatchObject({ name: "Main", status: "working" });
		expect(rows.helpers.map((row) => [row.name, row.task])).toEqual([
			["build-2", "Task sk"],
			["research-1", "Task now"],
		]);
		expect(rows.helpers[0]).toMatchObject({
			status: "working",
			queued: 1,
			tag: null,
			messageable: true,
		});
		expect(rows.helpers[1]).toMatchObject({
			status: "done",
			tag: null,
			messageable: false,
		});
	});
	it("says each row's state once, sentence-cased, in its line", () => {
		const done = task("d", {
			status: "done",
			turnStatus: "completed",
			summary: "Parser fixed; 4 tests added.",
		});
		const bare = task("b", { status: "done", turnStatus: "completed" });
		const failed = task("f", { status: "failed", turnStatus: "failed" });
		const working = task("w", {
			items: [tool("r", "read", { path: "docs/api.md" }, "inProgress")],
		});
		const rows = agentPanelRows({
			tasks: [done, bare, failed, working],
			leadItems: [],
			leadTurnStatus: "completed",
		});
		expect(rows.lead.doing).toBe("Free while helpers work");
		expect(
			rows.helpers.map((row) => [row.name, row.doing, row.doingDetail]),
		).toEqual([
			["build-1", "Done", undefined],
			["build-2", "Done", "Parser fixed; 4 tests added."],
			["build-3", "Failed", undefined],
			["build-4", "Reading api.md", undefined],
		]);
		const idle = agentPanelRows({
			tasks: [],
			leadItems: [],
			leadTurnStatus: "completed",
		});
		expect(idle.lead).toMatchObject({
			status: "done",
			doing: "Waiting for you",
		});
		expect(
			agentPanelRows({ tasks: [], leadItems: [], leadTurnStatus: "failed" })
				.lead.doing,
		).toBe("Failed");
	});
	it("shows Main as free while its helpers work after its turn ended", () => {
		const rows = agentPanelRows({
			tasks: [task("sk", { sidekick: true })],
			leadItems: [],
			leadTurnStatus: "completed",
		});
		expect(rows.lead).toMatchObject({
			status: "free",
			doing: "Free while helpers work",
		});
	});
	it("says Main is free while commands run when only a background command works", () => {
		const rows = agentPanelRows({
			tasks: [],
			leadItems: [],
			leadTurnStatus: "completed",
			background: [
				{
					id: "c1",
					command: "pnpm test",
					status: "running",
					startedAt: 1,
				},
			],
		});
		expect(rows.lead).toMatchObject({
			status: "free",
			doing: "Free while commands run",
		});
	});
	it("lets the user message a sidekick resting between rounds, not a retired one", () => {
		const resting = (retired: boolean) =>
			task("sk", {
				status: "done",
				turnStatus: "completed",
				subagent: {
					role: "writer",
					vm: "shared",
					steps: 0,
					minutes: 0,
					budget: {
						sidekick: {
							maxRounds: 6,
							...(retired ? { retired: { at: "x", reason: "stopped" } } : {}),
						},
					} as never,
					spend: {} as never,
					subtree: {} as never,
				},
			});
		const row = (retired: boolean) =>
			agentPanelRows({
				tasks: [resting(retired)],
				leadItems: [],
				leadTurnStatus: "idle",
			}).helpers[0];
		expect(row(false)?.messageable).toBe(true);
		expect(row(true)?.messageable).toBe(false);
	});
	it("folds finished helpers into +N done when there are many, active first", () => {
		const row = (id: string, status: "working" | "done") =>
			({
				id,
				name: id,
				kind: "writer",
				tag: "Build",
				icon: "hammer",
				color: "",
				status,
				doing: "",
				queued: 0,
				title: "",
				messageable: false,
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
	it("fills the finish card with name, outcome, task, time and the report's first line past its heading", () => {
		const done = task("d", {
			title: "Fix pricing rounding",
			status: "done",
			turnStatus: "completed",
			createdAt: new Date(0).toISOString(),
			updatedAt: new Date(72_000).toISOString(),
			summary:
				'[agent 3 writer finished · build-1 ("Fix pricing rounding") · 12 steps · 1m · 362k tokens · $1.20]\n\n## Rounding fixed\nTotals now round half up.',
		});
		const card = helperFinishCard(done, {
			name: "build-1",
			task: "Fix pricing rounding",
		});
		expect(card).toEqual({
			name: "build-1",
			verb: "finished",
			task: "Fix pricing rounding",
			duration: "1m 12s",
			line: "Totals now round half up.",
			detail:
				"## Rounding fixed\nTotals now round half up.\n\n12 steps · 1m · 362k tokens · $1.20",
		});
		expect(card.detail).not.toContain("[agent");
	});
	it("says failed on a failed helper's card, with its error as the line", () => {
		const failed = task("f", {
			status: "failed",
			turnStatus: "failed",
			createdAt: new Date(0).toISOString(),
			updatedAt: new Date(5_000).toISOString(),
			items: [
				{
					kind: "error",
					id: SessionItemId("e"),
					message: "The model refused the request",
				} as SessionItem,
			],
		});
		expect(
			helperFinishCard(failed, { name: "build-1", task: "Task f" }),
		).toMatchObject({
			verb: "failed",
			line: "The model refused the request",
			duration: "5s",
		});
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
	it("puts the finish line in the report's wake-up turn live as it ends up, never above Main's earlier answer", () => {
		const main: SessionItem[] = [
			{
				kind: "userMessage",
				id: SessionItemId("p1"),
				text: "p1",
				timing: { startedAt: 1, completedAt: 100 },
			},
			tool("spawn", "agent", {}, "completed"),
			tool("t", "bash", { command: "ls" }, "completed"),
			{ kind: "agentMessage", id: SessionItemId("answer"), text: "Main" },
		];
		const wake: SessionItem = {
			kind: "notice",
			id: SessionItemId("wake"),
			message: "",
			wake: true,
		};
		const spawn = SessionItemId("spawn");
		// Finished after Main answered, its wake-up turn not in yet: last.
		expect(finishLineAnchorId(main, spawn, 200)).toBeUndefined();
		// Finished during Main's turn (Main waited for it): before the answer.
		expect(finishLineAnchorId(main, spawn, 50)).toBe("t");
		// The wake-up turn started, nothing in it yet or only its answer
		// streaming: at the turn's start, below Main's answer.
		expect(finishLineAnchorId([...main, wake], spawn, 200)).toBe("wake");
		const reply: SessionItem = {
			kind: "agentMessage",
			id: SessionItemId("reply"),
			text: "From the report",
		};
		expect(finishLineAnchorId([...main, wake, reply], spawn, 200)).toBe("wake");
		// Ended with work: after that work, before the wake-up turn's answer.
		const read = tool("read", "bash", { command: "cat r" }, "completed");
		expect(finishLineAnchorId([...main, wake, read, reply], spawn, 200)).toBe(
			"read",
		);
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

describe("an agent call in the timeline", () => {
	it("names the helper by its task with a kind tag, never a role word", () => {
		expect(
			helperCallLabel({ title: "Fix pricing rounding", role: "writer" }),
		).toEqual({ name: "Fix pricing rounding", tag: "Build" });
		expect(
			helperCallLabel({ title: "Build it", role: "writer", sidekick: true }),
		).toEqual({ name: "Build it", tag: "Build" });
		expect(
			helperCallLabel({ title: "Map the parser", role: "researcher" }).tag,
		).toBe("Research");
		expect(helperCallLabel({ title: "", role: "nope" })).toEqual({
			name: "Untitled task",
			tag: null,
		});
	});
});
