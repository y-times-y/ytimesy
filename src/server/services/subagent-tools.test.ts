import type { ToolSet } from "ai";
import { describe, expect, it, vi } from "vitest";
import { SessionItemId, WorkspaceId } from "#/domain/ids";
import type { SessionItem } from "#/domain/session-item";
import type { SubagentRole } from "#/domain/subagent";
import type { AgentSessionRecord } from "../adapters/agent-sessions";
import { type SubagentToolDeps, subagentTools } from "./subagent-tools";
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
		markFailed: vi.fn(async () => {}),
		takeReport: vi.fn(async () => null),
		message: vi.fn(async () => ({}) as never),
		stop: vi.fn(async () => {}),
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
	return { sessions, deps, call, exec };
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
			budget: { steps: 25, minutes: 5, tokens: 1_000_000 },
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
