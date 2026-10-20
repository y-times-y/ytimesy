import type { ToolSet } from "ai";
import { describe, expect, it, vi } from "vitest";
import type { LeadMode } from "#/domain/harness-variant";
import { SessionItemId, WorkspaceId } from "#/domain/ids";
import type { FailoverConnection } from "#/domain/model-failover";
import type { RoleModels } from "#/domain/role-models";
import type { SessionItem } from "#/domain/session-item";
import {
	newSidekickState,
	SIDEKICK_EXPLORE_NOTE,
	type SidekickState,
} from "#/domain/sidekick";
import type { SubagentRole } from "#/domain/subagent";
import type { AgentSessionRecord } from "../adapters/agent-sessions";
import {
	type SubagentToolDeps,
	startRuntimeSubagent,
	subagentTools,
} from "./subagent-tools";
import type { WorkspaceMachines } from "./workspace-machines";

const NOW = Date.parse("2026-10-18T12:00:00.000Z");
const at = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();

type Row = AgentSessionRecord;

function row(
	id: string,
	parent: string | null,
	fields: Partial<Row> = {},
): Row {
	return {
		id,
		userId: "user",
		projectId: "project",
		parentSessionId: parent,
		title: id,
		turnStatus: "idle",
		harness: "api",
		listedModelId: "anthropic/claude-sonnet-5.5",
		createdAt: at(-10),
		updatedAt: at(-1),
		items: [],
		providerRef: parent ? null : "vm-root",
		...fields,
	} as Row;
}

const userTask: SessionItem[] = [
	{
		kind: "userMessage",
		id: SessionItemId("u1"),
		text: "Add a --json flag to the CLI and test it.",
	},
];

function harness(
	options: {
		sessions?: Row[];
		parent?: Row;
		ancestors?: Row[];
		deps?: Partial<SubagentToolDeps>;
		roleModels?: RoleModels;
		lead?: LeadMode;
	} = {},
) {
	const sessions: Row[] = options.sessions ?? [
		row("root", null, { items: userTask }),
	];
	const parent = options.parent ?? (sessions[0] as Row);
	let created = 0;
	const exec = vi.fn(async (_vm: WorkspaceId, command: string) => ({
		exitCode: 0,
		stdout: command.includes("status --porcelain")
			? " M src/cli.ts\n?? test/cli.test.ts\n"
			: "",
		stderr: "",
	}));
	const deps = {
		now: () => NOW,
		sleep: vi.fn(async () => {}),
		ancestors: vi.fn(async () => options.ancestors ?? []),
		tree: vi.fn(async () => sessions),
		session: vi.fn(
			async (_user: string, id: string) =>
				sessions.find((entry) => entry.id === id) ?? null,
		),
		openTask: vi.fn(
			async (input: {
				parentSessionId: string;
				title: string;
				prompt: string;
			}) => {
				const child = row(`child-${++created}`, input.parentSessionId, {
					title: input.title,
					createdAt: at(created),
					turnStatus: "running",
					taskPrompt: input.prompt,
				});
				sessions.push(child);
				return child;
			},
		),
		saveSpec: vi.fn(
			async (
				_user: string,
				id: string,
				spec: { role: SubagentRole; budget: unknown },
			) => {
				const child = sessions.find((entry) => entry.id === id);
				if (child)
					Object.assign(child, {
						agentRole: spec.role,
						agentBudget: spec.budget,
					});
			},
		),
		fork: vi.fn(async () => ({
			vm: WorkspaceId("vm-fork"),
			forkMs: 4200,
			cwd: "/home/user/app",
			base: "base-sha",
			parentHead: "head-sha",
		})),
		saveProviderRef: vi.fn(async () => ({}) as never),
		mergeFork: vi.fn(async () => {}),
		start: vi.fn(async () => ({})),
		routes: vi.fn(async () => []),
		markFailed: vi.fn(async () => {}),
		takeReport: vi.fn(async () => null),
		message: vi.fn(async () => ({}) as never),
		stop: vi.fn(async () => {}),
		syncSidekick: vi.fn(async () => ({
			status: "carried" as const,
			base: "lead-tree-sha",
			parentHead: "lead-head-sha",
			previousHead: "own-head-sha",
		})),
		saveSidekick: vi.fn(
			async (id: string, state: SidekickState, options?: object) => {
				const child = sessions.find((entry) => entry.id === id);
				if (child)
					Object.assign(child, {
						agentBudget: {
							...child.agentBudget,
							...(options ? { stopAtStep: undefined } : {}),
							sidekick: state,
						},
					});
			},
		),
		retireSidekick: vi.fn(async () => "retired" as const),
		...options.deps,
	} satisfies SubagentToolDeps;
	const tools: ToolSet = subagentTools({
		machines: { exec } as unknown as WorkspaceMachines,
		parent,
		workspace: async () => ({
			machines: { exec } as unknown as WorkspaceMachines,
			vm: WorkspaceId("vm-root"),
			cwd: "/home/user/app",
		}),
		signal: new AbortController().signal,
		deps,
		roleModels: options.roleModels,
		lead: options.lead,
	});
	const call = (name: string, input: unknown) =>
		tools[name]?.execute?.(
			input as never,
			{
				toolCallId: "call",
				messages: [],
				context: undefined,
			} as never,
		) as Promise<Record<string, unknown>>;
	return { sessions, deps, call, exec, parent };
}

describe("agent tool", () => {
	it("forks a writer: fresh read-write child, fork VM recorded, level-1 budget, started in the background", async () => {
		const { deps, call } = harness();
		const result = await call("agent", {
			role: "writer",
			title: "Add the flag",
			brief: "Add --json to src/cli.ts only. Report what changed.",
		});
		expect(result).toEqual({
			id: "1",
			taskId: "child-1",
			role: "writer",
			vm: "fork",
			model: "anthropic/claude-sonnet-5.5",
			budget: { steps: 150, minutes: 30, tokens: 2_000_000 },
		});
		expect(deps.openTask).toHaveBeenCalledWith(
			expect.objectContaining({
				placement: "fresh",
				access: "read_write",
				parentSessionId: "root",
				modelId: "anthropic/claude-sonnet-5.5",
			}),
		);
		expect(deps.fork).toHaveBeenCalledWith(
			expect.objectContaining({ parentVm: "vm-root" }),
		);
		expect(deps.saveProviderRef).toHaveBeenCalledWith("child-1", "vm-fork");
		expect(deps.mergeFork).toHaveBeenCalledWith(
			"child-1",
			expect.objectContaining({
				vmId: "vm-fork",
				sourceVmId: "vm-root",
				base: "base-sha",
				parentHead: "head-sha",
			}),
		);
		expect(deps.start).toHaveBeenCalledTimes(1);
	});

	it("shares the VM read-only with a reader and never forks", async () => {
		const { deps, call } = harness();
		const result = await call("agent", {
			role: "researcher",
			title: "Find the CLI entry",
			brief: "Where is the CLI parsed? Cite file:line.",
		});
		expect(result).toMatchObject({
			vm: "shared-read-only",
			role: "researcher",
		});
		expect(deps.openTask).toHaveBeenCalledWith(
			expect.objectContaining({ placement: "shared", access: "read_only" }),
		);
		expect(deps.fork).not.toHaveBeenCalled();
	});

	it("builds the checker's brief from the user's task and the deliverable only", async () => {
		const { deps, call } = harness();
		await expect(
			call("agent", {
				role: "checker",
				title: "Check",
				brief: "It works, trust me",
			}),
		).rejects.toThrow("A checker takes no brief");
		await call("agent", { role: "checker", title: "Check" });
		const prompt = vi.mocked(deps.openTask).mock.calls[0]?.[0].prompt as string;
		expect(prompt).toContain("Add a --json flag to the CLI and test it.");
		expect(prompt).toContain("src/cli.ts, test/cli.test.ts");
		expect(prompt).not.toContain("trust me");
	});

	it("refuses before creating anything: depth, live children, tree size, roles", async () => {
		const deep = harness({
			parent: row("l3", "l2", { agentRole: "researcher" }),
			ancestors: [row("l2", "l1"), row("l1", "root"), row("root", null)],
		});
		await expect(
			deep.call("agent", { role: "researcher", title: "x", brief: "y" }),
		).rejects.toThrow("Agents at level 3 cannot spawn. Do this work yourself.");

		const live = (count: number, parent = "root") =>
			Array.from({ length: count }, (_, index) =>
				row(`live-${parent}-${index}`, parent, {
					agentRole: "researcher",
					turnStatus: "running",
					createdAt: at(index),
				}),
			);
		const busy = harness({ sessions: [row("root", null), ...live(4)] });
		await expect(
			busy.call("agent", { role: "researcher", title: "x", brief: "y" }),
		).rejects.toThrow("You already have 4 running agents (at most 4).");

		const level1 = row("p", "root", {
			agentRole: "writer",
			agentBudget: { steps: 150, minutes: 30, tokens: 2_000_000 },
			createdAt: at(-5),
			turnStatus: "running",
		});
		const full = harness({
			sessions: [
				row("root", null),
				level1,
				...live(3),
				...live(4, "other"),
				row("other", "root", { agentRole: "writer", turnStatus: "running" }),
			],
			parent: level1,
			ancestors: [row("root", null)],
		});
		await expect(
			full.call("agent", { role: "researcher", title: "x", brief: "y" }),
		).rejects.toThrow("already runs 8 agents");

		const reader = row("r", "root", { agentRole: "reviewer" });
		const readerParent = harness({
			sessions: [row("root", null), reader],
			parent: reader,
			ancestors: [row("root", null)],
		});
		await expect(
			readerParent.call("agent", { role: "writer", title: "x", brief: "y" }),
		).rejects.toThrow("A read-only agent cannot start a writer");
		const { call, deps } = harness();
		await expect(
			call("agent", { role: "writer", title: "x", brief: "y", wait: true }),
		).rejects.toThrow("Only readers can be awaited");
		await expect(
			call("agent", { role: "reviewer", title: "x" }),
		).rejects.toThrow("A brief is required");
		expect(deps.openTask).not.toHaveBeenCalled();
	});

	it("caps a child's budget at half of its parent's remaining budget", async () => {
		const parent = row("p", "root", {
			agentRole: "writer",
			agentBudget: { steps: 150, minutes: 30, tokens: 2_000_000 },
			agentSteps: 100,
			createdAt: at(-20),
			turnStatus: "running",
		});
		const { deps, call } = harness({
			sessions: [row("root", null), parent],
			parent,
			ancestors: [row("root", null)],
		});
		const result = await call("agent", {
			role: "researcher",
			title: "x",
			brief: "y",
		});
		// Level 2 allows 75 steps / 15 min / 1M; the parent has 50 / 10 / 2M left.
		expect(result.budget).toEqual({ steps: 25, minutes: 5, tokens: 1_000_000 });
		expect(deps.saveSpec).toHaveBeenCalledWith("user", "child-1", {
			role: "researcher",
			budget: {
				steps: 25,
				minutes: 5,
				tokens: 1_000_000,
				priceBasis: "anthropic/claude-sonnet-5.5",
			},
		});
	});

	it("marks the child failed when the fork or start fails", async () => {
		const { deps, call } = harness({
			deps: {
				fork: vi.fn(async () => {
					throw new Error("snapshot refused");
				}),
			},
		});
		await expect(
			call("agent", { role: "writer", title: "x", brief: "y" }),
		).rejects.toThrow("snapshot refused");
		expect(deps.markFailed).toHaveBeenCalledWith("child-1");
		expect(deps.start).not.toHaveBeenCalled();
	});

	it("returns an awaited reader's report and claims it so it is not delivered twice", async () => {
		const takeReport = vi
			.fn()
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce({
				outcome: "completed",
				report: "Found it at src/cli.ts:12",
			});
		const { call, deps } = harness({ deps: { takeReport } });
		const result = await call("agent", {
			role: "researcher",
			title: "x",
			brief: "y",
			wait: true,
		});
		expect(result).toMatchObject({
			outcome: "completed",
			report: "Found it at src/cli.ts:12",
		});
		expect(deps.sleep).toHaveBeenCalledTimes(1);
	});
});

describe("agent_send", () => {
	const tree = () => [
		row("root", null),
		row("w", "root", { agentRole: "writer", turnStatus: "running" }),
	];

	it("steers a running child and stops one on request", async () => {
		const { call, deps } = harness({ sessions: tree() });
		expect(
			await call("agent_send", { id: "1", message: "Use port 4001." }),
		).toEqual({
			id: "1",
			status: "message queued",
			delivery: "next step",
		});
		expect(deps.message).toHaveBeenCalledWith(
			expect.objectContaining({ id: "root" }),
			"w",
			"Use port 4001.",
			expect.any(String),
		);
		expect(deps.stop).not.toHaveBeenCalled();
		const stopped = await call("agent_send", { id: "1", stop: true });
		expect(stopped.status).toBe("stopping");
		expect(deps.stop).toHaveBeenCalledWith("w");
		expect(vi.mocked(deps.message).mock.calls[1]?.[2]).toContain(
			"write your report now",
		);
	});

	it("names the caller's own agents when the id is not one of them", async () => {
		const { call } = harness({ sessions: tree() });
		await expect(
			call("agent_send", { id: "2", message: "hi" }),
		).rejects.toThrow("No agent 2 of yours. Your agents: 1 (writer, working).");
		await expect(call("agent_send", { id: "1" })).rejects.toThrow(
			"Pass a message, stop: true, or both.",
		);
	});
});

describe("runtime-started subagents (the attempt loop)", () => {
	it("starts a read-only checker with the runtime's brief and a capped budget", async () => {
		const { deps, exec, parent } = harness();
		const machines = { exec } as unknown as WorkspaceMachines;
		const started = await startRuntimeSubagent(
			{
				machines,
				parent,
				workspace: async () => ({
					machines,
					vm: WorkspaceId("vm-root"),
					cwd: "/home/user/app",
				}),
				signal: new AbortController().signal,
				deps,
			},
			{
				role: "checker",
				title: "Check attempt 1 of 3",
				brief: "<task>Add a --json flag</task> runtime brief",
				cap: { steps: 60, minutes: 4, tokens: 800_000 },
			},
		);
		expect(started).toEqual({
			sessionId: "child-1",
			budget: {
				steps: 60,
				minutes: 4,
				tokens: 800_000,
				priceBasis: "anthropic/claude-sonnet-5.5",
			},
			model: { harness: "api", modelId: "anthropic/claude-sonnet-5.5" },
		});
		expect(deps.openTask).toHaveBeenCalledWith(
			expect.objectContaining({
				prompt: "<task>Add a --json flag</task> runtime brief",
				placement: "shared",
				access: "read_only",
			}),
		);
		expect(deps.saveSpec).toHaveBeenCalledWith("user", "child-1", {
			role: "checker",
			budget: {
				steps: 60,
				minutes: 4,
				tokens: 800_000,
				priceBasis: "anthropic/claude-sonnet-5.5",
			},
		});
		expect(deps.fork).not.toHaveBeenCalled();
		expect(deps.start).toHaveBeenCalledOnce();
	});

	it("never raises a budget above the admitted one", async () => {
		const { deps, exec, parent } = harness();
		const machines = { exec } as unknown as WorkspaceMachines;
		const started = await startRuntimeSubagent(
			{
				machines,
				parent,
				workspace: async () => ({
					machines,
					vm: WorkspaceId("vm-root"),
					cwd: "/w",
				}),
				signal: new AbortController().signal,
				deps,
			},
			{ role: "reviewer", title: "Judge", brief: "b", cap: { steps: 999 } },
		);
		expect(started.budget).toEqual({
			steps: 150,
			minutes: 30,
			tokens: 2_000_000,
			priceBasis: "anthropic/claude-sonnet-5.5",
		});
	});
});

describe("role models", () => {
	const CONNECTION = "11111111-1111-4111-8111-111111111111";
	const routes: FailoverConnection[] = [
		{
			key: "codex",
			label: "Codex",
			kind: "subscription",
			revision: "",
			models: [
				{ id: "gpt-6.1-sol", label: "GPT-6.1 Sol", reasoning: ["low", "high"] },
				{ id: "gpt-6-luna", label: "GPT-6 Luna", reasoning: ["low", "high"] },
			],
		},
		{
			key: CONNECTION,
			label: "OpenRouter",
			kind: "gateway",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			revision: "r1",
			models: [{ id: "google/gemini-3.8-flash", label: "Gemini 3.8 Flash" }],
		},
	];

	it("runs a role on its own route and effort, with tokens counted at the builder's price", async () => {
		const { deps, call } = harness({
			roleModels: { researcher: { model: "codex:gpt-6-luna", effort: "low" } },
			deps: { routes: vi.fn(async () => routes) },
		});
		const result = await call("agent", {
			role: "researcher",
			title: "Find it",
			brief: "Where is the CLI parsed?",
		});
		// An API (Sonnet) builder starts a Codex-plan child.
		expect(deps.openTask).toHaveBeenCalledWith(
			expect.objectContaining({ harness: "codex", modelId: "gpt-6-luna" }),
		);
		expect(deps.start).toHaveBeenCalledWith(expect.anything(), "child-1", {
			reasoning: "low",
		});
		expect(result.model).toBe("GPT-6 Luna · Codex");
		// Luna is far cheaper than Sonnet: the 2M builder-token budget is shown
		// in Luna's tokens at the 4× hard cap.
		expect(result.budget).toEqual({
			steps: 150,
			minutes: 30,
			tokens: 8_000_000,
		});
		expect(result).not.toHaveProperty("modelNotice");
	});

	it("resolves an API model under any connection for a role", async () => {
		const { deps, call } = harness({
			roleModels: { writer: { model: "api:gemini-3.8-flash" } },
			deps: { routes: vi.fn(async () => routes) },
		});
		await call("agent", { role: "writer", title: "w", brief: "b" });
		expect(deps.openTask).toHaveBeenCalledWith(
			expect.objectContaining({
				harness: "api",
				modelId: `api/${CONNECTION}/google%2Fgemini-3.8-flash`,
			}),
		);
	});

	it("falls back to the parent's model with a notice when the route is unavailable", async () => {
		const { deps, call } = harness({
			roleModels: { reviewer: { model: "codex:gpt-6-astra" } },
			deps: { routes: vi.fn(async () => routes) },
		});
		const result = await call("agent", {
			role: "reviewer",
			title: "r",
			brief: "b",
		});
		expect(deps.openTask).toHaveBeenCalledWith(
			expect.objectContaining({
				harness: "api",
				modelId: "anthropic/claude-sonnet-5.5",
			}),
		);
		expect(String(result.modelNotice)).toContain(
			'roleModels.reviewer "codex:gpt-6-astra" is not available',
		);
	});

	it("gives the runtime's judge the judge entry, else the reviewer's", async () => {
		const { deps, exec, parent } = harness({
			deps: { routes: vi.fn(async () => routes) },
		});
		const machines = { exec } as unknown as WorkspaceMachines;
		const started = await startRuntimeSubagent(
			{
				machines,
				parent,
				workspace: async () => ({
					machines,
					vm: WorkspaceId("vm-root"),
					cwd: "/w",
				}),
				signal: new AbortController().signal,
				deps,
				roleModels: { reviewer: { model: "gpt-6-luna" } },
			},
			{ role: "reviewer", modelRole: "judge", title: "Judge", brief: "b" },
		);
		expect(started.model).toEqual({ harness: "codex", modelId: "gpt-6-luna" });
		expect(deps.routes).toHaveBeenCalledWith("user");
	});

	it("never lists routes when no role model is set", async () => {
		const routesFake = vi.fn(async () => routes);
		const { call } = harness({ deps: { routes: routesFake } });
		await call("agent", { role: "researcher", title: "x", brief: "y" });
		expect(routesFake).not.toHaveBeenCalled();
	});
});

describe("lead mode fusion: the persistent sidekick", () => {
	const brief = {
		role: "writer",
		title: "Add the flag",
		brief: "Add --json to src/cli.ts; done when npm test passes.",
	};
	const fork = {
		vmId: "vm-fork",
		sourceVmId: "vm-root",
		bootedAt: at(-10),
		base: "base-sha",
		parentHead: "head-sha",
	};
	/** A sidekick that reported round `round` and is idle now. */
	const idleSidekick = (fields: Partial<SidekickState> = {}) =>
		row("s", "root", {
			agentRole: "writer",
			turnStatus: "completed",
			agentSteps: 40,
			agentBudget: {
				steps: 150,
				minutes: 30,
				tokens: 2_000_000,
				sidekick: {
					...newSidekickState({ tokens: 2_000_000 }, at(-10)),
					...fields,
				},
			},
			agentFork: fork,
		});

	it("makes the lead's first writer its sidekick and refuses a second writer while it lives", async () => {
		const { call, deps, sessions } = harness({ lead: "fusion" });
		const started = await call("agent", brief);
		expect(started).toMatchObject({ id: "1", role: "writer", vm: "fork" });
		expect(started.sidekick).toContain(
			"Your persistent sidekick for this chat: up to 6 rounds per user request",
		);
		const child = sessions.find((entry) => entry.id === "child-1");
		expect(child?.agentBudget?.sidekick).toMatchObject({
			round: 1,
			maxRounds: 6,
			roundStartSteps: 0,
			roundTokens: 1_000_000,
		});
		await expect(call("agent", { ...brief, title: "Another" })).rejects.toThrow(
			"Your sidekick 1 is still available (working): send it the next brief or feedback with agent_send (id 1)",
		);
		// Readers are still fine beside it.
		await call("agent", {
			role: "researcher",
			title: "Map",
			brief: "Where is X?",
		});
		expect(deps.openTask).toHaveBeenCalledTimes(2);
	});

	it("keeps ordinary writers with lead=off", async () => {
		const { call, sessions } = harness();
		const started = await call("agent", brief);
		expect(started.sidekick).toBeUndefined();
		expect(
			sessions.find((entry) => entry.id === "child-1")?.agentBudget?.sidekick,
		).toBeUndefined();
		await call("agent", { ...brief, title: "Second writer" });
	});

	it("starts round 2 in the same session: syncs the fork with the lead's checkout, then delivers the feedback", async () => {
		const sessions = [row("root", null), idleSidekick()];
		const { call, deps } = harness({ sessions, lead: "fusion" });
		const result = await call("agent_send", {
			id: "1",
			message: "The --json output misses the exit code; add it and test it.",
		});
		expect(result).toMatchObject({
			id: "1",
			status: "round 2/6 started",
			delivery: "now",
		});
		expect(result.checkout).toContain(
			"plus its earlier work you have not applied",
		);
		// The fork synced from the lead's VM, against the fork's recorded base.
		expect(deps.syncSidekick).toHaveBeenCalledWith(
			expect.objectContaining({
				leadVm: "vm-root",
				forkVm: "vm-fork",
				label: "1",
				round: 2,
				base: "base-sha",
				parentHead: "head-sha",
			}),
		);
		// The next patch is relative to the lead's checkout.
		expect(deps.mergeFork).toHaveBeenCalledWith("s", {
			base: "lead-tree-sha",
			parentHead: "lead-head-sha",
		});
		const state = sessions[1]?.agentBudget?.sidekick as SidekickState;
		expect(state).toMatchObject({ round: 2, roundStartSteps: 40 });
		expect(state.rounds.at(-1)).toMatchObject({ n: 2, sync: "carried" });
		expect(deps.saveSidekick).toHaveBeenCalledWith("s", expect.anything(), {
			clearStop: true,
		});
		// The same agent session (its context) receives the message; nothing new is spawned.
		expect(deps.openTask).not.toHaveBeenCalled();
		expect(deps.fork).not.toHaveBeenCalled();
		const [, recipient, text] = vi.mocked(deps.message).mock.calls[0] ?? [];
		expect(recipient).toBe("s");
		expect(text).toMatch(
			/^Round 2\/6 from your lead\. Your checkout now matches/,
		);
		expect(text).toContain("The --json output misses the exit code");
		// Sync happens before delivery.
		expect(
			vi.mocked(deps.syncSidekick).mock.invocationCallOrder[0],
		).toBeLessThan(
			vi.mocked(deps.message).mock.invocationCallOrder[0] as number,
		);
	});

	it("steers a working sidekick without a new round", async () => {
		const sessions = [
			row("root", null),
			{ ...idleSidekick(), turnStatus: "running" } as never,
		];
		const { call, deps } = harness({ sessions, lead: "fusion" });
		expect(
			await call("agent_send", { id: "1", message: "Use port 4001." }),
		).toMatchObject({
			status: "message queued",
		});
		expect(deps.syncSidekick).not.toHaveBeenCalled();
		expect(deps.saveSidekick).not.toHaveBeenCalled();
	});

	it("caps the rounds and refuses a retired sidekick", async () => {
		const full = harness({
			sessions: [row("root", null), idleSidekick({ round: 6 })],
			lead: "fusion",
		});
		await expect(
			full.call("agent_send", { id: "1", message: "again" }),
		).rejects.toThrow(
			"Sidekick 1 has used all 6 rounds. Take over, or stop it and start a new writer.",
		);
		expect(full.deps.syncSidekick).not.toHaveBeenCalled();
		const retired = harness({
			sessions: [
				row("root", null),
				idleSidekick({
					retired: { at: at(-1), reason: "stopped by the lead" },
				}),
			],
			lead: "fusion",
		});
		await expect(
			retired.call("agent_send", { id: "1", message: "again" }),
		).rejects.toThrow("Sidekick 1 is retired (stopped by the lead)");
		// A retired sidekick no longer blocks a new writer, which becomes the next sidekick.
		const next = await retired.call("agent", brief);
		expect(next.sidekick).toBeDefined();
	});

	it("retires an idle sidekick on stop (its fork goes now) and stops a working one", async () => {
		const idle = harness({
			sessions: [row("root", null), idleSidekick()],
			lead: "fusion",
		});
		expect(
			await idle.call("agent_send", { id: "1", stop: true }),
		).toMatchObject({
			status: "retired",
		});
		expect(idle.deps.retireSidekick).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ id: "s" }),
			"stopped by the lead",
		);
		expect(idle.deps.message).not.toHaveBeenCalled();
		const working = harness({
			sessions: [
				row("root", null),
				{ ...idleSidekick(), turnStatus: "running" } as never,
			],
			lead: "fusion",
			deps: { retireSidekick: vi.fn(async () => "stopping" as const) },
		});
		expect(
			await working.call("agent_send", { id: "1", stop: true }),
		).toMatchObject({
			status: "stopping",
		});
		expect(working.deps.stop).toHaveBeenCalledWith("s");
	});

	it("marks an exploration round: the brief asks for snippets and the round is recorded as explore", async () => {
		const { call, deps, sessions } = harness({
			lead: "fusion",
			sessions: [row("root", null, { items: userTask })],
		});
		await call("agent", { ...brief, explore: true });
		const prompt = vi.mocked(deps.openTask).mock.calls[0]?.[0].prompt;
		expect(prompt).toContain(brief.brief);
		expect(prompt).toContain(SIDEKICK_EXPLORE_NOTE);
		const state = sessions.find((entry) => entry.id === "child-1")?.agentBudget
			?.sidekick as SidekickState;
		expect(state.rounds[0]).toMatchObject({ n: 1, kind: "explore" });
		expect(state.requestKey).toBe("u1");
		// The pair's tuning is recorded for the sidekick's own prompt.
		expect(state.pair?.name).toBe("default");
		// Only the sidekick explores.
		await expect(
			call("agent", {
				role: "researcher",
				title: "r",
				brief: "b",
				explore: true,
			}),
		).rejects.toThrow("explore applies only to your sidekick");
	});

	it("serves the chat's next user request with a fresh round count", async () => {
		const sessions = [
			row("root", null, { items: userTask }),
			idleSidekick({ round: 6, requestKey: "u0" }),
		];
		const { call, deps } = harness({ sessions, lead: "fusion" });
		const result = await call("agent_send", {
			id: "1",
			message: "The user now wants --yaml too.",
			explore: true,
		});
		expect(result.status).toBe("round 7 (1/6 this turn) started");
		const state = sessions[1]?.agentBudget?.sidekick as SidekickState;
		expect(state).toMatchObject({
			round: 7,
			turnFirstRound: 7,
			turns: 2,
			requestKey: "u1",
		});
		expect(state.rounds.at(-1)).toMatchObject({ n: 7, kind: "explore" });
		const text = vi.mocked(deps.message).mock.calls[0]?.[2];
		expect(text).toMatch(
			/^Round 7 from your lead \(1\/6 for the user's new request\)\./,
		);
		expect(text).toContain(SIDEKICK_EXPLORE_NOTE);
		// The same session takes it: no new writer.
		expect(deps.openTask).not.toHaveBeenCalled();
	});

	it("restarts a stuck sidekick on roleModels.writerEscalation with a handover", async () => {
		const stuck = (escalate: boolean) => {
			const sidekick = idleSidekick({
				rounds: [
					{
						n: 1,
						startedAt: at(-10),
						endedAt: at(-5),
						outcome: "finished",
						patchFiles: 1,
						signals: [{ kind: "same-check-failed", detail: "npm test" }],
					},
				],
			});
			Object.assign(sidekick, {
				listedModelId: "gpt-6-luna",
				harness: "codex",
				items: [
					{
						kind: "agentMessage",
						id: SessionItemId("a1"),
						text: "npm test still fails on the exit code.",
					},
				],
				agentFork: {
					...fork,
					patch: { path: "/home/user/.ytimesy/agents/1.patch", files: [] },
				},
			});
			return harness({
				sessions: [row("root", null, { items: userTask }), sidekick],
				lead: "fusion",
				roleModels: escalate
					? {
							writer: { model: "codex:gpt-6-luna" },
							writerEscalation: { model: "codex:gpt-6.1-sol" },
						}
					: { writer: { model: "codex:gpt-6-luna" } },
				deps: {
					routes: vi.fn(async () => [
						{
							key: "codex",
							label: "Codex",
							kind: "subscription",
							revision: "",
							models: [
								{ id: "gpt-6.1-sol", label: "GPT-6.1 Sol" },
								{ id: "gpt-6-luna", label: "GPT-6 Luna" },
							],
						} as FailoverConnection,
					]),
				},
			});
		};
		const escalated = stuck(true);
		const result = await escalated.call("agent_send", {
			id: "1",
			message: "Make npm test pass: print the exit code in --json.",
		});
		expect(result.status).toContain("sidekick 1 was stuck");
		expect(result.status).toContain("restarted as sidekick 2");
		expect(escalated.deps.retireSidekick).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ id: "s" }),
			expect.stringContaining("restarted on gpt-6.1-sol"),
		);
		expect(escalated.deps.syncSidekick).not.toHaveBeenCalled();
		const opened = vi.mocked(escalated.deps.openTask).mock.calls[0]?.[0];
		expect(opened).toMatchObject({ harness: "codex", modelId: "gpt-6.1-sol" });
		expect(opened?.prompt).toContain("npm test still fails on the exit code.");
		expect(opened?.prompt).toContain("/home/user/.ytimesy/agents/1.patch");
		expect(opened?.prompt).toContain("print the exit code in --json");
		const next = escalated.sessions.find((entry) => entry.id === "child-1")
			?.agentBudget?.sidekick as SidekickState;
		expect(next.escalatedFrom).toMatchObject({
			label: "1",
			model: "gpt-6-luna",
		});
		// Without an escalation model the stuck sidekick simply takes the next round.
		const plain = stuck(false);
		expect(
			(await plain.call("agent_send", { id: "1", message: "again" })).status,
		).toBe("round 2/6 started");
		expect(plain.deps.retireSidekick).not.toHaveBeenCalled();
	});

	it("fails the round's start, not the sidekick, when its fork is gone", async () => {
		const gone = row("s", "root", {
			...idleSidekick(),
			agentFork: { ...fork, deletedAt: at(-1) },
		});
		const { call, deps } = harness({
			sessions: [row("root", null), gone],
			lead: "fusion",
		});
		await expect(
			call("agent_send", { id: "1", message: "next" }),
		).rejects.toThrow("Sidekick 1's fork is gone");
		expect(deps.message).not.toHaveBeenCalled();
	});
});
