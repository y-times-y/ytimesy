import type { ModelMessage } from "ai";
import { describe, expect, it, vi } from "vitest";
import { SessionItemId } from "#/domain/ids";
import type { FailoverConnection } from "#/domain/model-failover";
import type { SessionItem } from "#/domain/session-item";
import { newSidekickState, type SidekickState } from "#/domain/sidekick";
import type { SidekickDecisionRecord } from "#/domain/sidekick-classifier";
import { subscriptionTurnRevision } from "#/domain/subscription-turn";
import type { AgentSessionRecord } from "../adapters/agent-sessions";
import {
	completeSidekickModelSwitch,
	sidekickSwitchAllowed,
	sidekickSwitchAtCompaction,
} from "./sidekick-model-switch";

const NOW = Date.parse("2026-10-20T12:00:00.000Z");
const roleModels = {
	writer: { model: "codex:gpt-6-luna" },
	writerEscalation: { model: "codex:gpt-6.1-sol", effort: "high" },
};
const routes = async (): Promise<FailoverConnection[]> => [
	{
		key: "codex",
		label: "Codex",
		kind: "subscription",
		revision: "",
		models: [
			{ id: "gpt-6-luna", label: "GPT-6 Luna" },
			{ id: "gpt-6.1-sol", label: "GPT-6.1 Sol", reasoning: ["high"] },
		],
	},
];

function sidekick(state: Partial<SidekickState> = {}) {
	return {
		id: "s",
		userId: "user",
		agentRole: "writer",
		listedModelId: "gpt-6-luna",
		harness: "codex",
		agentBudget: {
			steps: 100,
			minutes: 30,
			tokens: 1_000_000,
			sidekick: {
				...newSidekickState({ tokens: 1_000_000 }, new Date(NOW).toISOString()),
				round: 2,
				...state,
			},
		},
	} as unknown as AgentSessionRecord;
}

const record: SidekickDecisionRecord = {
	point: "compaction",
	round: 2,
	decision: "switch_model",
	reason: "it keeps failing make test",
	source: "classifier",
	inputsHash: "h",
	latencyMs: 9,
	tokens: 50,
	costUsd: 0,
	planBilled: true,
	at: new Date(NOW).toISOString(),
};

const items: SessionItem[] = [
	{ kind: "userMessage", id: SessionItemId("b"), text: "Add the flag." },
	{
		kind: "userMessage",
		id: SessionItemId("r2"),
		text: "Round 2/6 from your lead. Fix make test.",
	},
];

/** A compare-and-set fake over one stored state; `stored` is what a concurrent writer left. */
function store(stored: SidekickState) {
	const saved: { state: SidekickState; model?: unknown }[] = [];
	const updateState = vi.fn(
		async (
			_id: string,
			mutate: (current: SidekickState) => SidekickState | null,
			model?: unknown,
		) => {
			const next = mutate(stored);
			if (!next) return null;
			const kept =
				stored.retired && !next.retired
					? { ...next, retired: stored.retired }
					: next;
			saved.push({ state: kept, model });
			return kept;
		},
	);
	return { updateState, saved };
}

const stateOf = (session: AgentSessionRecord) =>
	session.agentBudget?.sidekick as SidekickState;
const pending = {
	to: "codex:gpt-6.1-sol",
	reason: "it repeats make test",
	round: 1,
	at: "x",
};

describe("sidekickSwitchAtCompaction", () => {
	const hookFor = (
		session: AgentSessionRecord | null,
		deps: Record<string, unknown> = {},
		models: typeof roleModels = roleModels,
		turnId = "turn",
	) =>
		sidekickSwitchAtCompaction({
			userId: "user",
			sessionId: "s",
			turnId,
			roleModels: models,
			items: () => items,
			deps: { session: vi.fn(async () => session), ...deps },
		});

	it("switches at a compaction when a switch is pending, without asking again", async () => {
		const classify = vi.fn();
		const hook = hookFor(sidekick({ pendingSwitch: pending }), { classify });
		expect(await hook({ forced: true })).toEqual({
			target: {
				spec: "codex:gpt-6.1-sol",
				reason: "it repeats make test",
				trigger: "pending",
			},
		});
		expect(classify).not.toHaveBeenCalled();
	});

	it("asks the classifier at any other compaction, records its decision on the stored state, and returns its usage", async () => {
		const usage = {
			inputTokens: 900,
			outputTokens: 30,
			uncachedInputTokens: 900,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
		};
		// The lead stopped the sidekick while the classifier ran.
		const { updateState, saved } = store({
			...stateOf(sidekick()),
			retired: { at: "y", reason: "stopped by the lead" },
		});
		const decide = (decision: SidekickDecisionRecord["decision"]) =>
			hookFor(sidekick(), {
				updateState,
				classify: vi.fn(async (summary) => {
					expect(summary).toMatchObject({
						point: "compaction",
						round: 2,
						brief: "Round 2/6 from your lead. Fix make test.",
						canSwitch: true,
					});
					return {
						answer: { decision, reason: record.reason },
						record: { ...record, decision },
						usage,
					};
				}),
			})({ forced: false });
		expect(await decide("switch_model")).toEqual({
			target: {
				spec: "codex:gpt-6.1-sol",
				reason: "it keeps failing make test",
				trigger: "compaction",
			},
			usage,
		});
		expect((await decide("hand_back")).target).toBeNull();
		expect(saved[0]?.state.decisions).toEqual([
			{ ...record, decision: "switch_model" },
		]);
		// Never resurrected.
		expect(saved[0]?.state.retired?.reason).toBe("stopped by the lead");
	});

	it("never switches without an escalation model, a live sidekick, or in a turn whose switch was dropped", async () => {
		const classify = vi.fn();
		expect(
			(
				await hookFor(sidekick(), { classify }, {
					writer: roleModels.writer,
				} as never)({ forced: false })
			).target,
		).toBeNull();
		expect(
			(await hookFor(null, { classify })({ forced: false })).target,
		).toBeNull();
		expect(
			(
				await hookFor(sidekick({ retired: { at: "x", reason: "stopped" } }), {
					classify,
				})({ forced: false })
			).target,
		).toBeNull();
		expect(
			(
				await hookFor(
					sidekick({ pendingSwitch: pending, switchBlockedTurn: "turn" }),
					{ classify },
				)({ forced: true })
			).target,
		).toBeNull();
		expect(classify).not.toHaveBeenCalled();
	});
});

describe("completeSidekickModelSwitch", () => {
	const messages: ModelMessage[] = [
		{ role: "assistant", content: "Summary of earlier conversation: …" },
		{ role: "user", content: "Round 2/6 from your lead. Fix it." },
	];
	const current = {
		route: {
			connectionId: null,
			connectionRevision: subscriptionTurnRevision("low"),
			modelId: "gpt-6-luna",
		},
		label: { model: "gpt-6-luna", connection: "Codex" },
	};
	const complete = (
		session: AgentSessionRecord,
		updateState: ReturnType<typeof store>["updateState"],
		turnId: string,
		models: Record<string, unknown> = roleModels,
		spec = "codex:gpt-6.1-sol",
	) =>
		completeSidekickModelSwitch({
			userId: "user",
			sessionId: "s",
			turnId,
			roleModels: models,
			target: { spec, reason: "it repeats make test", trigger: "pending" },
			compacted: true,
			current,
			previous: null,
			messages,
			deps: {
				session: vi.fn(async () => session),
				routes,
				updateState: updateState as never,
				now: () => NOW,
			},
		});

	it("moves the same session to the escalation route and records the switch in one write", async () => {
		const session = sidekick({ pendingSwitch: pending });
		const { updateState, saved } = store(stateOf(session));
		const outcome = await complete(session, updateState, "turn-a");
		expect(outcome.kind).toBe("switched");
		if (outcome.kind !== "switched") return;
		expect(outcome.failover.route).toEqual({
			connectionId: null,
			connectionRevision: subscriptionTurnRevision("high"),
			modelId: "gpt-6.1-sol",
		});
		expect(outcome.failover.switches).toBe(1);
		expect(outcome).toMatchObject({
			from: "gpt-6-luna",
			to: "gpt-6.1-sol",
			label: { model: "GPT-6.1 Sol", connection: "Codex" },
		});
		// The model and the state change together.
		expect(saved).toHaveLength(1);
		expect(saved[0]?.model).toEqual({
			listedModelId: "gpt-6.1-sol",
			harness: "codex",
		});
		const state = saved[0]?.state as SidekickState;
		expect(state.pendingSwitch).toBeUndefined();
		expect(state.model).toBe("gpt-6.1-sol");
		expect(state.switches).toEqual([
			{
				from: "gpt-6-luna",
				to: "gpt-6.1-sol",
				reason: "it repeats make test",
				round: 2,
				trigger: "pending",
				compacted: true,
				at: new Date(NOW).toISOString(),
			},
		]);
		expect(JSON.stringify(outcome.messages)).toContain(
			"Summary of earlier conversation",
		);
		expect(String(outcome.messages.at(-1)?.content)).toContain(
			"you now run on gpt-6.1-sol",
		);
	});

	it("does not switch a sidekick retired meanwhile, and blocks the turn", async () => {
		const session = sidekick({ pendingSwitch: pending });
		const { updateState, saved } = store({
			...stateOf(session),
			retired: { at: "y", reason: "stopped by the lead" },
		});
		const outcome = await complete(session, updateState, "turn-b");
		expect(outcome).toEqual({
			kind: "kept",
			reason: "the sidekick was retired meanwhile",
		});
		expect(saved.every((entry) => entry.model === undefined)).toBe(true);
		expect(saved.at(-1)?.state.retired?.reason).toBe("stopped by the lead");
		expect(sidekickSwitchAllowed(stateOf(session), "turn-b")).toBe(false);
	});

	it("drops an unavailable switch once per turn, even when its state cannot be saved", async () => {
		const session = sidekick({ pendingSwitch: pending });
		const updateState = vi.fn(async () => {
			throw new Error("database unavailable");
		});
		const outcome = await complete(
			session,
			updateState as never,
			"turn-c",
			{ writerEscalation: { model: "api:google/gemini-3.8-pro" } },
			"api:google/gemini-3.8-pro",
		);
		expect(outcome.kind).toBe("kept");
		// The pending switch is still stored, but this turn will not try again.
		expect(sidekickSwitchAllowed(stateOf(session), "turn-c")).toBe(false);
		expect(sidekickSwitchAllowed(stateOf(session), "turn-d")).toBe(true);
	});
});
