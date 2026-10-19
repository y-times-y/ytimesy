import type { ModelMessage } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionItemId } from "#/domain/ids";
import type { SessionItem } from "#/domain/session-item";
import type { AgentSessionRecord } from "../adapters/agent-sessions";

const adapters = vi.hoisted(() => ({
	ancestors: vi.fn(),
	tree: vi.fn(),
	session: vi.fn(),
	mergeFork: vi.fn(async () => {}),
	transfer: vi.fn(),
}));
vi.mock("../adapters/subagents", () => ({
	subagentAncestors: adapters.ancestors,
	subagentTree: adapters.tree,
	mergeSubagentFork: adapters.mergeFork,
	recordSubagentStep: vi.fn(),
	forkedWritersDueForTeardown: vi.fn(async () => []),
}));
vi.mock("../adapters/agent-sessions", () => ({
	agentSessionForOwner: adapters.session,
	descendantAgentSessions: vi.fn(async () => []),
}));
vi.mock("./subagent-writer", () => ({
	transferWriterPatch: adapters.transfer,
}));

const { guardSubagentStep, SubagentBudgetExhausted, subagentReport } =
	await import("./subagent-runtime");

const NOW = Date.parse("2026-10-18T12:00:00.000Z");
const at = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();

const used = (input: number): SessionItem[] => [
	{
		kind: "userMessage",
		id: SessionItemId("u"),
		text: "brief",
		apiUsage: {
			inputTokens: input,
			outputTokens: 0,
			uncachedInputTokens: input,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
		},
	},
];

const budget = { steps: 100, minutes: 30, tokens: 1_000_000 };
const session = {
	id: "child",
	userId: "user",
	createdAt: at(-5),
	agentRole: "researcher" as const,
	agentBudget: budget,
};
const messages: ModelMessage[] = [{ role: "user", content: "brief" }];

function guard(
	steps: number,
	options: {
		items?: SessionItem[];
		descendants?: SessionItem[][];
		budget?: typeof budget & { stopAtStep?: number };
		history?: ModelMessage[];
	} = {},
) {
	return guardSubagentStep({
		session,
		items: options.items ?? [],
		messages: options.history ?? messages,
		now: NOW,
		deps: {
			recordStep: vi.fn(async () => ({
				steps,
				budget: options.budget ?? budget,
			})),
			descendants: vi.fn(async () =>
				(options.descendants ?? []).map(
					(items) => ({ items }) as unknown as AgentSessionRecord,
				),
			),
		},
	});
}

describe("subagent step guard", () => {
	it("passes the history through while under 90% of every budget", async () => {
		expect(await guard(10)).toBe(messages);
	});

	it("adds the wrap-up notice once at 90%", async () => {
		const wrapped = await guard(90);
		expect(wrapped).toHaveLength(2);
		expect(wrapped[1]?.content).toContain("Budget nearly used (steps 90/100)");
		expect(await guard(91, { history: wrapped })).toBe(wrapped);
	});

	it("stops the turn at 100%, counting descendants' tokens against it", async () => {
		await expect(guard(100)).rejects.toBeInstanceOf(SubagentBudgetExhausted);
		await expect(
			guard(1, { items: used(400_000), descendants: [used(600_000)] }),
		).rejects.toThrow("Budget exhausted (tokens 1,000,000/1,000,000).");
	});

	it("wraps up after agent_send stop and stops at the stop step", async () => {
		const stopping = { ...budget, stopAtStep: 13 };
		const wrapped = await guard(11, { budget: stopping });
		expect(wrapped.at(-1)?.content).toContain("the parent asked you to stop");
		await expect(guard(13, { budget: stopping })).rejects.toThrow(
			"stopped by the parent",
		);
	});

	it("counts a cheaper model's tokens at the builder's price", async () => {
		const luna = {
			...session,
			listedModelId: "gpt-6-luna",
			agentBudget: { ...budget, priceBasis: "anthropic/claude-opus-5.5" },
		};
		const step = (tokens: number) =>
			guardSubagentStep({
				session: luna,
				items: used(tokens),
				messages,
				now: NOW,
				deps: {
					recordStep: vi.fn(async () => ({
						steps: 1,
						budget: luna.agentBudget,
					})),
					descendants: vi.fn(async () => []),
				},
			});
		// 3M Luna tokens weigh 0.75M Opus tokens (the 0.25 floor): under budget.
		expect(await step(3_000_000)).toBe(messages);
		// 4M weigh the whole 1M budget: the turn stops.
		await expect(step(4_000_000)).rejects.toBeInstanceOf(
			SubagentBudgetExhausted,
		);
	});
});

function record(
	id: string,
	parent: string | null,
	fields: Partial<AgentSessionRecord> = {},
) {
	return {
		id,
		userId: "user",
		projectId: "project",
		parentSessionId: parent,
		title: id,
		turnStatus: "running",
		harness: "api",
		listedModelId: "anthropic/claude-sonnet-5.5",
		createdAt: at(-6),
		updatedAt: at(0),
		items: [],
		providerRef: null,
		...fields,
	} as AgentSessionRecord;
}

describe("subagent report", () => {
	const root = record("root", null, { providerRef: "vm-root" });
	const writer = record("w", "root", {
		agentRole: "writer",
		agentSteps: 41,
		agentFork: {
			vmId: "vm-fork",
			sourceVmId: "vm-root",
			bootedAt: at(-6),
			base: "base-sha",
			parentHead: "head-sha",
		},
	});
	const sibling = record("w2", "root", {
		agentRole: "writer",
		createdAt: at(-4),
		agentFork: {
			vmId: "vm-2",
			sourceVmId: "vm-root",
			bootedAt: at(-4),
			patch: {
				path: "~/.ytimesy/agents/2.patch",
				files: ["src/api/user.ts"],
				added: 1,
				removed: 1,
				sha256: "b".repeat(64),
				ref: "refs/ytimesy/agents/2",
				base: "base-sha",
			},
		},
	});

	beforeEach(() => {
		adapters.ancestors.mockResolvedValue([root]);
		adapters.tree.mockResolvedValue([root, writer, sibling]);
		adapters.session.mockImplementation(
			async (_user: string, id: string) =>
				[root, writer, sibling].find((entry) => entry.id === id) ?? null,
		);
		adapters.transfer.mockResolvedValue({
			path: "~/.ytimesy/agents/1.patch",
			files: ["src/api/user.ts", "src/cli.ts"],
			added: 120,
			removed: 30,
			sha256: "a".repeat(64),
			ref: "refs/ytimesy/agents/1",
			base: "base-sha",
		});
	});

	it("gives a writer's parent the header, the report, the patch and overlaps", async () => {
		const report = await subagentReport({
			machines: {} as never,
			session: writer,
			items: used(380_000),
			outcome: "finished",
			text: "Added the flag; npm test exit 0.",
			now: NOW,
		});
		expect(report).toContain(
			"[agent 1 writer finished · 41 steps · 6m · 380k tokens · $0.76]",
		);
		expect(report).toContain("Added the flag; npm test exit 0.");
		expect(report).toContain(
			"Patch: ~/.ytimesy/agents/1.patch (2 files, +120 −30",
		);
		expect(report).toContain("Ref:   refs/ytimesy/agents/1   Base: base-sha");
		expect(report).toContain("Overlaps with: agent 2 (src/api/user.ts)");
		expect(adapters.transfer).toHaveBeenCalledWith(
			expect.objectContaining({
				forkVm: "vm-fork",
				parentVm: "vm-root",
				label: "1",
			}),
		);
		expect(adapters.mergeFork).toHaveBeenCalledWith(
			"w",
			expect.objectContaining({ reportedAt: new Date(NOW).toISOString() }),
		);
	});

	it("still reports a failed writer, saying why the patch did not transfer", async () => {
		adapters.transfer.mockRejectedValueOnce(new Error("fork VM is gone"));
		const report = await subagentReport({
			machines: {} as never,
			session: writer,
			items: [],
			outcome: "budget exhausted",
			text: "Budget exhausted (steps 150/150).",
			now: NOW,
		});
		expect(report).toContain("[agent 1 writer budget exhausted");
		expect(report).toContain("Patch: not transferred (fork VM is gone).");
	});

	it("labels a plan-billed agent's dollars as a list-price estimate", async () => {
		const plan = { ...writer, harness: "codex" as const };
		adapters.tree.mockResolvedValue([root, plan]);
		const report = await subagentReport({
			machines: {} as never,
			session: plan,
			items: used(1_000_000),
			outcome: "finished",
			text: "done",
			now: NOW,
		});
		expect(report).toMatch(/· ~\$[\d.]+ list-price est\.\]/);
	});
});
