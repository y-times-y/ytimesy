import { describe, expect, it } from "vitest";
import { SessionItemId } from "./ids";
import type { SessionItem } from "./session-item";
import {
	beginSidekickRound,
	endSidekickRound,
	fusionMetricsLine,
	fusionTurnMetrics,
	isActiveSidekick,
	latestUserRequestId,
	newSidekickState,
	retireSidekickState,
	sidekickIdleSince,
	sidekickIdleTtlMinutes,
	sidekickPatchLabel,
	sidekickRoundLabel,
	sidekickRoundMessage,
	sidekickRoundsLeft,
	subagentBudgetCheck,
} from "./sidekick";

const T0 = Date.parse("2026-10-19T10:00:00.000Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

describe("sidekick rounds", () => {
	it("starts at round 1 with half its tokens per round", () => {
		const state = newSidekickState({ tokens: 2_000_000 }, at(0));
		expect(state).toMatchObject({
			round: 1,
			maxRounds: 6,
			roundTokens: 1_000_000,
			rounds: [{ n: 1, startedAt: at(0) }],
		});
		expect(newSidekickState({ tokens: 60_000 }, at(0)).roundTokens).toBe(
			50_000,
		);
	});

	it("records each round and retires the sidekick after its last", () => {
		let state = newSidekickState({ tokens: 2_000_000 }, at(0));
		state = endSidekickRound(state, {
			now: at(5),
			outcome: "finished",
			patchFiles: 3,
		});
		expect(state.rounds[0]).toMatchObject({ endedAt: at(5), patchFiles: 3 });
		for (let n = 2; n <= 6; n++) {
			state = beginSidekickRound(state, {
				now: at(n * 10),
				steps: n * 20,
				tokens: n * 1000,
				sync: n % 2 ? "carried" : "clean",
			});
			expect(state).toMatchObject({
				round: n,
				roundStartSteps: n * 20,
				roundStartedAt: at(n * 10),
			});
			state = endSidekickRound(state, {
				now: at(n * 10 + 3),
				outcome: "finished",
				patchFiles: 1,
			});
		}
		expect(state.rounds).toHaveLength(6);
		expect(sidekickRoundsLeft(state)).toBe(0);
		expect(state.retired).toEqual({ at: at(63), reason: "all rounds used" });
		expect(
			isActiveSidekick({
				agentRole: "writer",
				agentBudget: { steps: 1, minutes: 1, tokens: 1, sidekick: state },
			}),
		).toBe(false);
		// A retirement keeps its first reason.
		expect(retireSidekickState(state, "stopped", at(70)).retired?.reason).toBe(
			"all rounds used",
		);
	});

	it("checks a sidekick's budget per round and an ordinary agent's over its life", () => {
		const budget = { steps: 100, minutes: 30, tokens: 1_000_000 };
		expect(
			subagentBudgetCheck(
				budget,
				{ steps: 40, tokens: 1000, createdAt: at(0) },
				T0 + 45 * 60_000,
			),
		).toEqual({
			limits: budget,
			used: { steps: 40, minutes: 45, tokens: 1000 },
			reasonPrefix: "",
		});
		const state = beginSidekickRound(newSidekickState(budget, at(0)), {
			now: at(40),
			steps: 70,
			tokens: 600_000,
			sync: "clean",
		});
		const check = subagentBudgetCheck(
			{ ...budget, sidekick: state, stopAtStep: 75 },
			{ steps: 72, tokens: 650_000, createdAt: at(0) },
			T0 + 45 * 60_000,
		);
		expect(check.used).toEqual({ steps: 2, minutes: 5, tokens: 50_000 });
		expect(check.limits).toMatchObject({
			steps: 100,
			minutes: 30,
			tokens: 400_000,
			stopAtStep: 5,
		});
		expect(check.reasonPrefix).toBe("round 2, ");
	});

	it("names later rounds' patches and tells the sidekick how its checkout changed", () => {
		expect(sidekickPatchLabel("1", 1)).toBe("1");
		expect(sidekickPatchLabel("1", 3)).toBe("1.r3");
		const conflict = sidekickRoundMessage({
			round: 3,
			maxRounds: 6,
			sync: "conflict",
			message: "  Fix the parser. ",
		});
		expect(conflict).toMatch(/^Round 3\/6 from your lead\./);
		expect(conflict).toContain("refs/ytimesy/sidekick/round-2");
		expect(conflict.endsWith("\n\nFix the parser.")).toBe(true);
	});
});

describe("sidekick lifetime across the chat's requests", () => {
	it("counts rounds per user request and labels later requests' rounds", () => {
		let state = newSidekickState({ tokens: 2_000_000 }, at(0), {
			requestKey: "u1",
			kind: "explore",
		});
		expect(state.rounds[0]?.kind).toBe("explore");
		for (let n = 2; n <= 6; n++)
			state = beginSidekickRound(
				endSidekickRound(state, {
					now: at(n),
					outcome: "finished",
					patchFiles: 1,
				}),
				{ now: at(n), steps: 0, tokens: 0, sync: "clean", requestKey: "u1" },
			);
		expect(sidekickRoundsLeft(state, "u1")).toBe(0);
		// The user's next message: a fresh count for the same sidekick.
		expect(sidekickRoundsLeft(state, "u2")).toBe(6);
		state = endSidekickRound(state, {
			now: at(7),
			outcome: "finished",
			patchFiles: 1,
		});
		// The sixth round of a request retires it.
		expect(state.retired?.reason).toBe("all rounds used");
		const kept = beginSidekickRound(
			{ ...state, retired: undefined },
			{ now: at(60), steps: 0, tokens: 0, sync: "clean", requestKey: "u2" },
		);
		expect(kept).toMatchObject({ round: 7, turnFirstRound: 7, turns: 2 });
		expect(sidekickRoundLabel(kept)).toBe("round 7 (1/6 this turn)");
		expect(sidekickRoundsLeft(kept, "u2")).toBe(5);
		expect(sidekickIdleSince(kept)).toBeNull();
		expect(sidekickIdleSince(state)).toBe(at(7));
	});

	it("reads the idle TTL from the environment, 30 minutes by default", () => {
		expect(sidekickIdleTtlMinutes({})).toBe(30);
		expect(sidekickIdleTtlMinutes({ YTIMESY_SIDEKICK_IDLE_MINUTES: "5" })).toBe(
			5,
		);
		expect(
			sidekickIdleTtlMinutes({ YTIMESY_SIDEKICK_IDLE_MINUTES: "never" }),
		).toBe(30);
	});

	it("finds the latest user request, skipping child reports and peer messages", () => {
		const items: SessionItem[] = [
			{ kind: "userMessage", id: SessionItemId("u1"), text: "Build it" },
			{
				kind: "userMessage",
				id: SessionItemId("c1"),
				text: "\u2063ytimesy-child-event:abc\n[agent 1 writer finished]",
			},
			{
				kind: "userMessage",
				id: SessionItemId("p1"),
				text: "Peer message from x (y):\n\nhello",
			},
		];
		expect(latestUserRequestId(items)).toBe("u1");
		expect(latestUserRequestId([])).toBeUndefined();
	});
});

describe("fusion turn metrics", () => {
	const usage = (input: number, output: number) => ({
		inputTokens: input,
		outputTokens: output,
		uncachedInputTokens: input,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
	});
	const call = (tool: string, input: unknown, id: string): SessionItem => ({
		kind: "dynamicToolCall",
		id: SessionItemId(id),
		tool,
		input: JSON.stringify(input),
		status: "completed",
	});
	const leadItems: SessionItem[] = [
		{
			kind: "userMessage",
			id: SessionItemId("u"),
			text: "Build it",
			apiUsage: usage(100_000, 5_000),
		},
		call("agent", { role: "writer", title: "x", brief: "y" }, "1"),
		call("agent", { role: "researcher", title: "x", brief: "y" }, "2"),
		call("bash", { command: "git diff abc refs/ytimesy/agents/1" }, "3"),
		call(
			"bash",
			{ command: "git add -A && git apply -3 ~/.ytimesy/agents/1.patch" },
			"4",
		),
		call("agent_send", { id: "1", message: "fix it" }, "5"),
		call(
			"exec_command",
			{ cmd: "git apply -3 ~/.ytimesy/agents/1.r2.patch" },
			"6",
		),
		call("edit", { path: "a.ts" }, "7"),
		call("write", { path: "b.ts" }, "8"),
		call("apply_patch", { input: "*** Begin Patch" }, "9"),
		call("read", { path: "a.ts" }, "10"),
	];
	const state = endSidekickRound(
		beginSidekickRound(
			endSidekickRound(newSidekickState({ tokens: 2_000_000 }, at(0)), {
				now: at(6),
				outcome: "finished",
				patchFiles: 2,
			}),
			{ now: at(10), steps: 30, tokens: 10_000, sync: "carried" },
		),
		{
			now: at(14),
			outcome: "finished",
			patchFiles: 1,
			signals: [{ kind: "same-check-failed", detail: "make test" }],
		},
	);
	const sessions = [
		{
			id: "root",
			parentSessionId: null,
			harness: "codex",
			listedModelId: "gpt-6.1-sol",
			items: leadItems,
		},
		{
			id: "s",
			parentSessionId: "root",
			harness: "codex",
			listedModelId: "gpt-6-luna",
			agentRole: "writer" as const,
			agentBudget: {
				steps: 150,
				minutes: 30,
				tokens: 2_000_000,
				sidekick: state,
			},
			items: [
				{
					kind: "userMessage",
					id: SessionItemId("s-u"),
					text: "brief",
					apiUsage: usage(400_000, 20_000),
				},
				call("read", { path: "src/a.ts" }, "s-1"),
				call("bash", { command: "sed -n 1,80p src/b.ts" }, "s-2"),
				call("bash", { command: "make test" }, "s-3"),
			] as SessionItem[],
		},
		{
			id: "r",
			parentSessionId: "root",
			harness: "codex",
			listedModelId: "gpt-6-luna",
			agentRole: "researcher" as const,
			items: [],
		},
	];

	it("counts handoffs, rounds, lead edits, applied patches, syncs, spend and time", () => {
		const metrics = fusionTurnMetrics({ rootId: "root", sessions });
		expect(metrics).toMatchObject({
			sidekicks: 1,
			handoffs: 2,
			sidekickRounds: 2,
			agentSends: 1,
			writersStarted: 1,
			leadEdits: 3,
			patchesApplied: 2,
			syncs: { unchanged: 0, clean: 0, carried: 1, conflict: 0 },
			sidekickBusyMinutes: 10,
			explorationHandoffs: 0,
			leadReads: 1,
			sidekickReads: 2,
			signals: { "same-check-failed": 1 },
			switches: 0,
			sidekickTurns: 1,
		});
		expect(metrics.lead.tokens).toBe(105_000);
		expect(metrics.sidekick.tokens).toBe(420_000);
		expect(metrics.others.tokens).toBe(0);
		const line = fusionMetricsLine(metrics, 1200);
		expect(line).toContain("handoffs 2 · rounds 2");
		expect(line).toContain("lead edits 3 · patches applied 2");
		expect(line).toContain("sidekick busy 10.0m of 20.0m");
		expect(line).toContain("explore 0 · reads lead 1/sidekick 2");
		expect(line).toContain("signals same-check-failed 1");
	});

	it("is all zeros for a builder that never delegated", () => {
		const metrics = fusionTurnMetrics({
			rootId: "root",
			sessions: [{ ...sessions[0], items: [] } as (typeof sessions)[0]],
		});
		expect(metrics).toMatchObject({
			sidekicks: 0,
			handoffs: 0,
			leadEdits: 0,
			patchesApplied: 0,
		});
	});
});
