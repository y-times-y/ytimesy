import type { ModelMessage } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionItemId } from "#/domain/ids";
import type { SessionItem } from "#/domain/session-item";
import {
	newSidekickState,
	retireSidekickState,
	type SidekickState,
} from "#/domain/sidekick";
import {
	type ClassifierInput,
	rulesDecision,
	type SidekickDecision,
	type SidekickDecisionRecord,
} from "#/domain/sidekick-classifier";
import type { AgentSessionRecord } from "../adapters/agent-sessions";

const adapters = vi.hoisted(() => ({
	ancestors: vi.fn(),
	tree: vi.fn(),
	session: vi.fn(),
	mergeFork: vi.fn(async () => {}),
	transfer: vi.fn(),
	idle: vi.fn(async (): Promise<unknown[]> => []),
	saveState: vi.fn(async () => {}),
}));
vi.mock("../adapters/subagents", () => ({
	subagentAncestors: adapters.ancestors,
	subagentTree: adapters.tree,
	mergeSubagentFork: adapters.mergeFork,
	recordSubagentStep: vi.fn(),
	forkedWritersDueForTeardown: vi.fn(async () => []),
	idleSidekicksPastTtl: adapters.idle,
	saveSidekickState: adapters.saveState,
	requestSubagentStop: vi.fn(async () => {}),
}));
vi.mock("../adapters/agent-sessions", () => ({
	agentSessionForOwner: adapters.session,
	descendantAgentSessions: vi.fn(async () => []),
}));
vi.mock("./subagent-writer", () => ({
	transferWriterPatch: adapters.transfer,
}));
// No model call in these tests: the classifier answers as its rules would.
vi.mock("./sidekick-classifier", () => ({
	classifySidekick: vi.fn(async ({ summary }: { summary: ClassifierInput }) => {
		const answer = rulesDecision(summary.signals, summary.canSwitch);
		return { answer, record: decisionRecord(answer.decision, "rules") };
	}),
}));

/** A compare-and-set fake: applies the change to `stored` (what the database holds now) and saves it. */
function applying(
	stored: SidekickState,
	save: (id: string, state: SidekickState) => Promise<void>,
) {
	return vi.fn(
		async (
			id: string,
			mutate: (current: SidekickState) => SidekickState | null,
		) => {
			const next = mutate(stored);
			if (next) await save(id, next);
			return next;
		},
	);
}

function decisionRecord(
	decision: SidekickDecision,
	source: SidekickDecisionRecord["source"] = "classifier",
): SidekickDecisionRecord {
	return {
		point: "round",
		round: 2,
		decision,
		reason: "test",
		source,
		inputsHash: "h",
		latencyMs: 5,
		tokens: 100,
		costUsd: 0.001,
		planBilled: true,
		at: "2026-10-18T12:00:00.000Z",
	};
}

const {
	guardSubagentStep,
	retireLeadSidekicks,
	SubagentBudgetExhausted,
	subagentReport,
	teardownSubagentForks,
} = await import("./subagent-runtime");

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

describe("sidekick (lead mode fusion)", () => {
	const sidekickState = (
		fields: Partial<SidekickState> = {},
	): SidekickState => ({
		...newSidekickState({ tokens: 1_000_000 }, at(-30)),
		...fields,
	});
	const sidekickBudget = (state: SidekickState) => ({
		...budget,
		sidekick: state,
	});
	const sidekickSession = (state: SidekickState) => ({
		...session,
		agentRole: "writer" as const,
		createdAt: at(-60),
		agentBudget: sidekickBudget(state),
	});
	const step = (
		state: SidekickState,
		steps: number,
		options: {
			items?: SessionItem[];
			history?: ModelMessage[];
			stopAtStep?: number;
		} = {},
	) =>
		guardSubagentStep({
			session: sidekickSession(state),
			items: options.items ?? [],
			messages: options.history ?? messages,
			now: NOW,
			deps: {
				recordStep: vi.fn(async () => ({
					steps,
					budget: {
						...sidekickBudget(state),
						...(options.stopAtStep === undefined
							? {}
							: { stopAtStep: options.stopAtStep }),
					},
				})),
				descendants: vi.fn(async () => []),
			},
		});
	const round2 = sidekickState({
		round: 2,
		roundStartedAt: at(-2),
		roundStartSteps: 95,
		roundStartTokens: 300_000,
	});

	it("counts steps and minutes from the round's start, not the agent's creation", async () => {
		// 140 steps in all, 60 minutes old: over an ordinary agent's budget,
		// but round 2 has used 45 steps and 2 minutes.
		expect(await step(round2, 140)).toBe(messages);
		await expect(step(round2, 195)).rejects.toThrow(
			"Budget exhausted (round 2, steps 100/100).",
		);
	});

	it("caps one round's tokens and the sidekick's lifetime tokens", async () => {
		// Round cap 500k: 300k before the round plus 520k now is 520k in the round.
		await expect(step(round2, 100, { items: used(820_000) })).rejects.toThrow(
			"round 2, tokens",
		);
		// Lifetime 1M: 900k before the round leaves 100k for it.
		const late = sidekickState({ ...round2, roundStartTokens: 900_000 });
		await expect(step(late, 100, { items: used(1_000_000) })).rejects.toThrow(
			"Budget exhausted (round 2, tokens 100,000/100,000).",
		);
	});

	it("wraps up once per round, though an earlier round's notice is in its history", async () => {
		const earlier: ModelMessage[] = [
			...messages,
			{
				role: "user",
				content: "Budget nearly used (round 1, steps 90/100). Wrap up now.",
			},
		];
		const wrapped = await step(round2, 185, { history: earlier });
		expect(wrapped).toHaveLength(3);
		expect(wrapped.at(-1)?.content).toContain(
			"Budget nearly used (round 2, steps 90/100)",
		);
		expect(await step(round2, 186, { history: wrapped })).toBe(wrapped);
	});

	it("applies an agent_send stop within the round", async () => {
		await expect(step(round2, 98, { stopAtStep: 98 })).rejects.toThrow(
			"stopped by the parent",
		);
	});

	it("reports each round's patch under its own name and keeps the sidekick for the next round", async () => {
		const root = record("root", null, { providerRef: "vm-root" });
		const state = sidekickState({
			round: 2,
			roundStartedAt: at(-3),
			rounds: [
				{
					n: 1,
					startedAt: at(-30),
					endedAt: at(-20),
					outcome: "finished",
					patchFiles: 2,
				},
				{ n: 2, startedAt: at(-3), sync: "clean" },
			],
		});
		const sidekick = record("s", "root", {
			agentRole: "writer",
			agentSteps: 60,
			agentBudget: sidekickBudget(state),
			agentFork: {
				vmId: "vm-fork",
				sourceVmId: "vm-root",
				bootedAt: at(-30),
				base: "lead-tree",
				parentHead: "lead-head",
			},
		});
		adapters.ancestors.mockResolvedValue([root]);
		adapters.tree.mockResolvedValue([root, sidekick]);
		adapters.transfer.mockResolvedValue({
			path: "~/.ytimesy/agents/1.r2.patch",
			files: ["src/cli.ts"],
			added: 3,
			removed: 1,
			sha256: "c".repeat(64),
			ref: "refs/ytimesy/agents/1.r2",
			base: "lead-tree",
		});
		const saveState = vi.fn(async () => {});
		const destroy = vi.fn(async () => {});
		const report = await subagentReport({
			machines: { destroy } as never,
			session: sidekick,
			items: used(10_000),
			outcome: "finished",
			text: "Fixed the flag; npm test exit 0.",
			now: NOW,
			deps: {
				session: vi.fn(async () => sidekick),
				updateState: applying(state, saveState),
				addUsage: vi.fn(async () => true),
				mergeFork: adapters.mergeFork,
			},
		});
		expect(report).toContain(
			"[agent 1 writer finished · round 2/6 · 60 steps · 3m",
		);
		expect(adapters.transfer).toHaveBeenCalledWith(
			expect.objectContaining({
				label: "1.r2",
				base: "lead-tree",
				parentHead: "lead-head",
			}),
		);
		expect(report).toContain("Sidekick 1: round 2/6 done.");
		const saved = (
			saveState.mock.calls[0] as unknown as [string, SidekickState]
		)[1];
		expect(saved.rounds.at(-1)).toMatchObject({
			n: 2,
			outcome: "finished",
			patchFiles: 1,
		});
		expect(saved.retired).toBeUndefined();
		expect(destroy).not.toHaveBeenCalled();
	});

	it("retires the sidekick and deletes its fork after its last round's report", async () => {
		const root = record("root", null, { providerRef: "vm-root" });
		const state = sidekickState({ round: 6, roundStartedAt: at(-1) });
		const sidekick = record("s", "root", {
			agentRole: "writer",
			agentBudget: sidekickBudget(state),
			agentFork: {
				vmId: "vm-fork",
				sourceVmId: "vm-root",
				bootedAt: at(-30),
				base: "lead-tree",
				parentHead: "lead-head",
			},
		});
		adapters.ancestors.mockResolvedValue([root]);
		adapters.tree.mockResolvedValue([root, sidekick]);
		const destroy = vi.fn(async () => {});
		const saveState = vi.fn(async () => {});
		const report = await subagentReport({
			machines: { destroy } as never,
			session: sidekick,
			items: [],
			outcome: "finished",
			text: "done",
			now: NOW,
			deps: {
				session: vi.fn(async () => sidekick),
				updateState: applying(state, saveState),
				addUsage: vi.fn(async () => true),
				mergeFork: adapters.mergeFork,
			},
		});
		expect(report).toContain(
			"Sidekick 1 is retired (all rounds used); its fork is deleted.",
		);
		expect(destroy).toHaveBeenCalledWith("vm-fork");
		expect(adapters.mergeFork).toHaveBeenCalledWith(
			"s",
			expect.objectContaining({ deletedAt: new Date(NOW).toISOString() }),
		);
	});

	it("classifies a stuck round and marks a model switch for the sidekick's next compaction", async () => {
		const root = record("root", null, { providerRef: "vm-root" });
		const state = sidekickState({
			round: 2,
			roundStartedAt: at(-3),
			rounds: [
				{
					n: 1,
					startedAt: at(-30),
					endedAt: at(-20),
					outcome: "finished",
					patchFiles: 1,
					evidence: {
						failedChecks: ["make test"],
						errors: ["make: *** [Makefile:#: test] Error #"],
					},
				},
				{ n: 2, startedAt: at(-3), sync: "clean", kind: "build" },
			],
		});
		const sidekick = record("s", "root", {
			agentRole: "writer",
			listedModelId: "gpt-6-luna",
			agentBudget: sidekickBudget(state),
			agentFork: {
				vmId: "vm-fork",
				sourceVmId: "vm-root",
				bootedAt: at(-30),
				base: "lead-tree",
				parentHead: "lead-head",
			},
		});
		adapters.ancestors.mockResolvedValue([root]);
		adapters.tree.mockResolvedValue([root, sidekick]);
		adapters.transfer.mockResolvedValue({
			path: "/home/u/.ytimesy/agents/1.r2.patch",
			files: ["src/cli.ts"],
			added: 1,
			removed: 0,
			sha256: "d".repeat(64),
			ref: "refs/ytimesy/agents/1.r2",
			base: "lead-tree",
		});
		const items: SessionItem[] = [
			{
				kind: "userMessage",
				id: SessionItemId("r1"),
				text: "Make the flag work.",
			},
			{
				kind: "dynamicToolCall",
				id: SessionItemId("old"),
				tool: "bash",
				input: JSON.stringify({ command: "make lint" }),
				output: "lint failed\n\nexit 2",
				status: "completed",
			},
			{
				kind: "userMessage",
				id: SessionItemId("r2"),
				text: "Peer message from lead (root):\n\nRound 2/6 from your lead. Fix it.",
			},
			{
				kind: "dynamicToolCall",
				id: SessionItemId("code"),
				tool: "run_code",
				input: "{}",
				output: JSON.stringify({
					ok: true,
					result: "",
					calls: [
						{
							tool: "bash",
							input: JSON.stringify({ command: "make  test" }),
							output: JSON.stringify({
								output: "make: *** [Makefile:12: test] Error 2\n",
								exitCode: 2,
							}),
							status: "completed",
						},
						{
							tool: "bash",
							input: JSON.stringify({ command: "grep -n missing src/cli.ts" }),
							output: JSON.stringify({ output: "", exitCode: 1 }),
							status: "completed",
						},
					],
				}),
				status: "completed",
			},
		];
		const saveState = vi.fn(async () => {});
		const classify = vi.fn(async (_summary: ClassifierInput) => ({
			answer: {
				decision: "switch_model" as const,
				reason: "it repeats make test",
			},
			record: decisionRecord("switch_model"),
			usage: null,
		}));
		const report = await subagentReport({
			machines: { destroy: vi.fn() } as never,
			session: sidekick,
			items,
			outcome: "finished",
			text: "Still failing.",
			now: NOW,
			roleModels: { writerEscalation: { model: "codex:gpt-6.1-sol" } },
			deps: {
				session: vi.fn(async () => sidekick),
				updateState: applying(state, saveState),
				addUsage: vi.fn(async () => true),
				mergeFork: adapters.mergeFork,
				classify,
			},
		});
		// The classifier sees the round: its brief, report, commands, diff and signals.
		const summary = classify.mock.calls[0]?.[0] as unknown as ClassifierInput;
		expect(summary).toMatchObject({
			point: "round",
			round: 2,
			model: "gpt-6-luna",
			brief: expect.stringContaining("Round 2/6 from your lead"),
			report: "Still failing.",
			diff: { files: ["src/cli.ts"], added: 1, removed: 0 },
			canSwitch: true,
		});
		expect(summary.commands).toEqual([
			{ command: "make test", exitCode: 2 },
			{ command: "grep -n missing src/cli.ts", exitCode: 1 },
		]);
		expect(summary.signals).toEqual([
			{ kind: "same-check-failed", detail: "make test" },
		]);
		expect(report).toContain(
			"Runtime notice: sidekick 1 looks stuck (it repeats make test).",
		);
		expect(report).toContain(
			"The runtime switches it to codex:gpt-6.1-sol at its next context compaction",
		);
		const saved = (
			saveState.mock.calls[0] as unknown as [string, SidekickState]
		)[1];
		expect(saved.pendingSwitch).toMatchObject({
			to: "codex:gpt-6.1-sol",
			reason: "it repeats make test",
			round: 2,
		});
		expect(saved.decisions?.[0]).toMatchObject({
			decision: "switch_model",
			source: "classifier",
		});
		// Only this round's failures count; a no-match grep is not a failure.
		expect(saved.rounds.at(-1)?.evidence?.failedChecks).toEqual(["make test"]);
		expect(saved.rounds.at(-1)?.signals).toEqual([
			{ kind: "same-check-failed", detail: "make test" },
		]);
	});

	it("applies the round's decision to the stored state: a sidekick the lead stopped meanwhile stays retired; its usage is charged", async () => {
		const root = record("root", null, { providerRef: "vm-root" });
		const state = sidekickState({ round: 2, roundStartedAt: at(-3) });
		const sidekick = record("s", "root", {
			agentRole: "writer",
			listedModelId: "gpt-6-luna",
			agentBudget: sidekickBudget(state),
			agentFork: {
				vmId: "vm-fork",
				sourceVmId: "vm-root",
				bootedAt: at(-30),
				base: "lead-tree",
				parentHead: "lead-head",
			},
		});
		adapters.ancestors.mockResolvedValue([root]);
		adapters.tree.mockResolvedValue([root, sidekick]);
		const usage = {
			inputTokens: 900,
			outputTokens: 30,
			uncachedInputTokens: 900,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
		};
		const saveState = vi.fn(async () => {});
		const addUsage = vi.fn(async () => true);
		const chargeUsage = vi.fn(async () => {});
		const stored = retireSidekickState(state, "stopped by the lead", at(-1));
		const report = await subagentReport({
			machines: { destroy: vi.fn(async () => {}) } as never,
			session: sidekick,
			items: [],
			outcome: "finished",
			text: "Still failing.",
			now: NOW,
			roleModels: { writerEscalation: { model: "codex:gpt-6.1-sol" } },
			deps: {
				session: vi.fn(async () => sidekick),
				updateState: applying(stored, saveState),
				addUsage,
				chargeUsage,
				mergeFork: adapters.mergeFork,
				classify: vi.fn(async () => ({
					answer: { decision: "switch_model" as const, reason: "stuck" },
					record: decisionRecord("switch_model"),
					usage,
				})),
			},
		});
		const saved = (
			saveState.mock.calls[0] as unknown as [string, SidekickState]
		)[1];
		expect(saved.retired?.reason).toBe("stopped by the lead");
		expect(saved.pendingSwitch).toBeUndefined();
		expect(saved.decisions).toHaveLength(1);
		expect(report).toContain("Sidekick 1 is retired (stopped by the lead)");
		expect(report).toContain("needs you (stuck)");
		expect(addUsage).toHaveBeenCalledWith("s", usage);
		expect(chargeUsage).toHaveBeenCalledWith(usage, "classifier:h");
	});

	it("keeps an idle sidekick for the chat's next message when the lead's turn completes", async () => {
		const state = sidekickState();
		const fork = (vmId: string) => ({
			vmId,
			sourceVmId: "vm-root",
			bootedAt: at(-30),
		});
		const idle = record("idle", "root", {
			agentRole: "writer",
			turnStatus: "completed",
			agentBudget: sidekickBudget(state),
			agentFork: fork("vm-idle"),
		});
		const running = record("running", "root", {
			agentRole: "writer",
			turnStatus: "running",
			agentBudget: sidekickBudget(state),
			agentFork: fork("vm-running"),
		});
		const destroy = vi.fn(async () => {});
		const stop = vi.fn(async () => {});
		const count = await retireLeadSidekicks(
			{ destroy } as never,
			{ userId: "user", id: "root" },
			"the lead's turn ended while it worked",
			{
				descendants: vi.fn(async () => [idle, running]),
				stop,
				saveState: vi.fn(async () => {}),
				mergeFork: adapters.mergeFork,
				now: () => NOW,
			},
			{ keepIdle: true },
		);
		expect(count).toBe(1);
		expect(destroy).not.toHaveBeenCalled();
		expect(stop).toHaveBeenCalledWith("running");
	});

	it("retires a sidekick idle past its TTL from the maintenance sweep", async () => {
		const idle = {
			id: "idle",
			agentRole: "writer" as const,
			agentBudget: sidekickBudget(sidekickState()),
			agentFork: { vmId: "vm-idle", sourceVmId: "vm-root", bootedAt: at(-90) },
			turnStatus: "completed" as const,
		};
		adapters.idle.mockResolvedValueOnce([idle]);
		adapters.saveState.mockClear();
		const destroy = vi.fn(async () => {});
		expect(await teardownSubagentForks({ destroy } as never, 30, 45)).toBe(1);
		expect(adapters.idle).toHaveBeenCalledWith(45);
		expect(destroy).toHaveBeenCalledWith("vm-idle");
		expect(adapters.saveState).toHaveBeenCalledWith(
			"idle",
			expect.objectContaining({
				retired: expect.objectContaining({
					reason: "idle for over 45 minutes",
				}),
			}),
		);
	});

	it("retires the lead's sidekicks when its turn ends: idle ones lose their fork now, running ones are stopped", async () => {
		const state = sidekickState();
		const fork = (vmId: string) => ({
			vmId,
			sourceVmId: "vm-root",
			bootedAt: at(-30),
		});
		const idle = record("idle", "root", {
			agentRole: "writer",
			turnStatus: "idle",
			agentBudget: sidekickBudget(state),
			agentFork: fork("vm-idle"),
		});
		const running = record("running", "root", {
			agentRole: "writer",
			turnStatus: "running",
			agentBudget: sidekickBudget(state),
			agentFork: fork("vm-running"),
		});
		const retired = record("retired", "root", {
			agentRole: "writer",
			turnStatus: "idle",
			agentBudget: sidekickBudget(
				retireSidekickState(state, "stopped", at(-5)),
			),
			agentFork: fork("vm-retired"),
		});
		const ordinary = record("writer", "root", {
			agentRole: "writer",
			turnStatus: "idle",
			agentBudget: budget,
			agentFork: fork("vm-writer"),
		});
		const destroy = vi.fn(async () => {});
		const stop = vi.fn(async () => {});
		const saveState = vi.fn(async () => {});
		const count = await retireLeadSidekicks(
			{ destroy } as never,
			{ userId: "user", id: "root" },
			"the lead's turn ended",
			{
				descendants: vi.fn(async () => [idle, running, retired, ordinary]),
				stop,
				saveState,
				mergeFork: adapters.mergeFork,
				now: () => NOW,
			},
		);
		expect(count).toBe(2);
		expect(destroy).toHaveBeenCalledTimes(1);
		expect(destroy).toHaveBeenCalledWith("vm-idle");
		expect(stop).toHaveBeenCalledWith("running");
		expect(saveState).toHaveBeenCalledWith(
			"running",
			expect.objectContaining({
				retired: {
					at: new Date(NOW).toISOString(),
					reason: "the lead's turn ended",
				},
			}),
		);
	});
});
