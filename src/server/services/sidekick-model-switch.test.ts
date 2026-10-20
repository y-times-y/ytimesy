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

describe("sidekickSwitchAtCompaction", () => {
	it("switches at a compaction when a switch is pending, without asking again", async () => {
		const classify = vi.fn();
		const hook = sidekickSwitchAtCompaction({
			userId: "user",
			sessionId: "s",
			roleModels,
			items: () => items,
			deps: {
				session: vi.fn(async () =>
					sidekick({
						pendingSwitch: {
							to: "codex:gpt-6.1-sol",
							reason: "it repeats make test",
							round: 1,
							at: new Date(NOW).toISOString(),
						},
					}),
				),
				classify,
			},
		});
		expect(await hook({ forced: true })).toEqual({
			spec: "codex:gpt-6.1-sol",
			reason: "it repeats make test",
			trigger: "pending",
		});
		expect(classify).not.toHaveBeenCalled();
	});

	it("asks the classifier at any other compaction and records its decision", async () => {
		const saveState = vi.fn(async () => {});
		const decide = (decision: SidekickDecisionRecord["decision"]) =>
			sidekickSwitchAtCompaction({
				userId: "user",
				sessionId: "s",
				roleModels,
				items: () => items,
				deps: {
					session: vi.fn(async () => sidekick()),
					saveState,
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
						};
					}),
				},
			})({ forced: false });
		expect(await decide("switch_model")).toEqual({
			spec: "codex:gpt-6.1-sol",
			reason: "it keeps failing make test",
			trigger: "compaction",
		});
		expect(await decide("hand_back")).toBeNull();
		expect(saveState).toHaveBeenCalledTimes(2);
		const saved = (
			saveState.mock.calls[0] as unknown as [string, SidekickState]
		)[1];
		expect(saved.decisions).toEqual([{ ...record, decision: "switch_model" }]);
	});

	it("never switches without an escalation model or a sidekick", async () => {
		const classify = vi.fn();
		const hook = (session: AgentSessionRecord | null, models = roleModels) =>
			sidekickSwitchAtCompaction({
				userId: "user",
				sessionId: "s",
				roleModels: models,
				items: () => items,
				deps: { session: vi.fn(async () => session), classify },
			})({ forced: false });
		expect(
			await hook(sidekick(), { writer: roleModels.writer } as never),
		).toBeNull();
		expect(await hook(null)).toBeNull();
		expect(
			await hook(sidekick({ retired: { at: "x", reason: "stopped" } })),
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

	it("moves the same session to the escalation route and records the switch", async () => {
		const saveModel = vi.fn(async () => {});
		const saveState = vi.fn(async () => {});
		const outcome = await completeSidekickModelSwitch({
			userId: "user",
			sessionId: "s",
			roleModels,
			target: {
				spec: "codex:gpt-6.1-sol",
				reason: "it repeats make test",
				trigger: "pending",
			},
			compacted: true,
			current,
			previous: null,
			messages,
			deps: {
				session: vi.fn(async () =>
					sidekick({
						pendingSwitch: {
							to: "codex:gpt-6.1-sol",
							reason: "it repeats make test",
							round: 1,
							at: "x",
						},
					}),
				),
				routes,
				saveModel,
				saveState,
				now: () => NOW,
			},
		});
		expect(outcome.kind).toBe("switched");
		if (outcome.kind !== "switched") return;
		expect(outcome.failover.route).toEqual({
			connectionId: null,
			connectionRevision: subscriptionTurnRevision("high"),
			modelId: "gpt-6.1-sol",
		});
		expect(outcome.failover.switches).toBe(1);
		expect(saveModel).toHaveBeenCalledWith("s", {
			listedModelId: "gpt-6.1-sol",
			harness: "codex",
		});
		const saved = (
			saveState.mock.calls[0] as unknown as [string, SidekickState]
		)[1];
		expect(saved.pendingSwitch).toBeUndefined();
		expect(saved.model).toBe("gpt-6.1-sol");
		expect(saved.switches).toEqual([
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
		// The summary carries over; a runtime note says what happened.
		expect(JSON.stringify(outcome.messages)).toContain(
			"Summary of earlier conversation",
		);
		expect(String(outcome.messages.at(-1)?.content)).toContain(
			"you now run on gpt-6.1-sol",
		);
	});

	it("drops the pending switch and keeps the route when the escalation model is unavailable", async () => {
		const saveState = vi.fn(async () => {});
		const saveModel = vi.fn(async () => {});
		const outcome = await completeSidekickModelSwitch({
			userId: "user",
			sessionId: "s",
			roleModels: { writerEscalation: { model: "api:google/gemini-3.8-pro" } },
			target: {
				spec: "api:google/gemini-3.8-pro",
				reason: "stuck",
				trigger: "pending",
			},
			compacted: true,
			current,
			previous: null,
			messages,
			deps: {
				session: vi.fn(async () =>
					sidekick({
						pendingSwitch: {
							to: "api:google/gemini-3.8-pro",
							reason: "stuck",
							round: 1,
							at: "x",
						},
					}),
				),
				routes,
				saveModel,
				saveState,
			},
		});
		expect(outcome.kind).toBe("kept");
		expect(saveModel).not.toHaveBeenCalled();
		const saved = (
			saveState.mock.calls[0] as unknown as [string, SidekickState]
		)[1];
		expect(saved.pendingSwitch).toBeUndefined();
	});
});
