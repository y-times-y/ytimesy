import { describe, expect, it } from "vitest";
import {
	attemptCostFromRun,
	attemptCostFromSessions,
	costSummary,
	costSummaryCells,
	formatCostSummary,
	runListPrice,
} from "./eval-cost";
import { SessionItemId } from "./ids";
import type { SessionItem } from "./session-item";
import type { SubagentTreeSession } from "./subagent-tree";

const NOW = Date.parse("2026-10-18T12:00:00.000Z");
const minutesAgo = (minutes: number) =>
	new Date(NOW - minutes * 60_000).toISOString();
const usage = (input: number, output: number): SessionItem[] => [
	{
		kind: "userMessage",
		id: SessionItemId(`u-${input}`),
		text: "go",
		apiUsage: {
			inputTokens: input,
			outputTokens: output,
			uncachedInputTokens: input,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
		},
	},
];
const session = (
	id: string,
	parent: string | null,
	fields: Partial<SubagentTreeSession> = {},
): SubagentTreeSession => ({
	id,
	parentSessionId: parent,
	title: id,
	turnStatus: "idle",
	harness: "api",
	listedModelId: "anthropic/claude-sonnet-5.5",
	createdAt: minutesAgo(20),
	updatedAt: minutesAgo(1),
	items: [],
	...fields,
});
const sessions = () => [
	session("root", null, { items: usage(1_000_000, 100_000) }),
	session("w", "root", {
		agentRole: "writer",
		createdAt: minutesAgo(10),
		agentFork: { vmId: "f", sourceVmId: "v", bootedAt: minutesAgo(9) },
		items: usage(400_000, 20_000),
	}),
	session("r", "w", {
		agentRole: "researcher",
		createdAt: minutesAgo(5),
		items: usage(100_000, 10_000),
	}),
];

describe("eval cost", () => {
	it("costs an attempt as its whole agent tree", () => {
		const attempt = attemptCostFromSessions({
			rootId: "root",
			sessions: sessions(),
			solved: true,
			now: NOW,
		});
		expect(attempt).toMatchObject({
			solved: true,
			tokens: 1_630_000,
			agents: 3,
			estimated: false,
		});
		expect(attempt.vmMinutes).toBeCloseTo(9);
	});

	it("divides all spend by solved tasks, so failures are paid for", () => {
		const summary = costSummary([
			{
				solved: true,
				tokens: 100,
				costUsd: 1,
				estimated: false,
				vmMinutes: 0,
				agents: 1,
			},
			{
				solved: false,
				tokens: 300,
				costUsd: 2,
				estimated: false,
				vmMinutes: 6,
				agents: 3,
			},
			{
				solved: true,
				tokens: 200,
				costUsd: 3,
				estimated: false,
				vmMinutes: 0,
				agents: 2,
			},
		]);
		expect(summary).toMatchObject({
			attempts: 3,
			solved: 2,
			totalUsd: 6,
			perAttemptUsd: 2,
			perSolvedUsd: 3,
			tokensPerAttempt: 200,
			tokensPerSolved: 300,
			vmMinutesPerAttempt: 2,
			meanAgents: 2,
			basis: "billed",
		});
		expect(costSummaryCells(summary)).toMatchObject({
			perAttempt: "$2.00",
			perSolved: "$3.00",
			note: "",
		});
	});

	it("marks estimates, unknown prices and nothing solved", () => {
		const estimate = costSummary([
			{
				solved: false,
				tokens: 10,
				costUsd: 0.05,
				estimated: true,
				vmMinutes: 0,
				agents: 1,
			},
		]);
		expect(estimate).toMatchObject({
			basis: "list-price estimate",
			perSolvedUsd: null,
		});
		expect(costSummaryCells(estimate)).toMatchObject({
			perAttempt: "~$0.050",
			perSolved: "-",
		});
		expect(formatCostSummary(estimate)).toContain("list-price estimate");
		const unknown = costSummary([
			{
				solved: true,
				tokens: 10,
				costUsd: null,
				estimated: false,
				vmMinutes: 0,
				agents: 1,
			},
		]);
		expect(unknown.basis).toBe("unknown");
		expect(costSummaryCells(unknown).perAttempt).toBe("-");
		expect(costSummary([]).perAttemptUsd).toBeNull();
	});
});

describe("eval run records", () => {
	it("prices a plan run at list price as an estimate and reads a run record", () => {
		const price = runListPrice({
			harness: "codex",
			modelId: "anthropic/claude-opus-5.5",
			inputTokens: 1_000_000,
			cachedTokens: 500_000,
			outputTokens: 100_000,
		});
		// 0.5M × $4 + 0.5M × $0.2 + 0.1M × $20
		expect(price.costUsd).toBeCloseTo(2 + 0.1 + 2);
		expect(price.estimated).toBe(true);
		expect(
			attemptCostFromRun({
				verifierPassed: true,
				inputTokens: 10,
				outputTokens: 5,
				costUsd: 0.01,
				costEstimated: true,
			}),
		).toEqual({
			solved: true,
			tokens: 15,
			costUsd: 0.01,
			estimated: true,
			vmMinutes: 0,
			agents: 1,
		});
	});
});
