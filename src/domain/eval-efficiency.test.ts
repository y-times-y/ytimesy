import { describe, expect, it } from "vitest";
import {
	efficiencySummary,
	formatEfficiencyBlock,
	treeModelSpend,
} from "./eval-efficiency";
import { SessionItemId } from "./ids";
import type { SessionItem } from "./session-item";

const ROUTE = "66666666-6666-4666-8666-666666666666";
const turn = (
	input: number,
	cached: number,
	output: number,
	requests: number,
): SessionItem[] => [
	{
		kind: "userMessage",
		id: SessionItemId(`u${input}`),
		text: "x",
		apiUsage: {
			inputTokens: input,
			outputTokens: output,
			uncachedInputTokens: input - cached,
			cacheReadTokens: cached,
			cacheWriteTokens: 0,
			requests,
		},
	},
];

describe("efficiency block", () => {
	const sessions = [
		{
			id: "root",
			harness: "codex",
			listedModelId: "gpt-6.1-sol",
			items: turn(1_000_000, 900_000, 10_000, 20),
		},
		{
			id: "w",
			harness: "api",
			listedModelId: `api/${ROUTE}/${encodeURIComponent("google/gemini-3.8-flash")}`,
			agentRole: "writer" as const,
			items: turn(400_000, 300_000, 8_000, 12),
		},
		{
			id: "c",
			harness: "codex",
			listedModelId: "gpt-6-luna",
			agentRole: "checker" as const,
			items: turn(200_000, 150_000, 2_000, 6),
		},
		{
			id: "j",
			harness: "codex",
			listedModelId: "gpt-6-luna",
			agentRole: "reviewer" as const,
			items: turn(50_000, 0, 1_000, 2),
		},
	];

	it("splits a tree's spend by role and model, each at its own price", () => {
		const rows = treeModelSpend({
			rootId: "root",
			sessions,
			judgeIds: new Set(["j"]),
		});
		expect(rows.map((row) => [row.role, row.model, row.requests])).toEqual([
			["builder", "gpt-6.1-sol", 20],
			["subagent", "google/gemini-3.8-flash", 12],
			["checker", "gpt-6-luna", 6],
			["judge", "gpt-6-luna", 2],
		]);
		// Sol: 100K × $2 + 900K × $0.10 + 10K × $10 (plan: an estimate).
		expect(rows[0].costUsd).toBeCloseTo(0.2 + 0.09 + 0.1);
		expect(rows[0].estimated).toBe(true);
		// Flash on an API route: 100K × $0.75 + 300K × $0.075 + 8K × $3.75.
		expect(rows[1].costUsd).toBeCloseTo(0.075 + 0.0225 + 0.03);
		expect(rows[1].estimated).toBe(false);
	});

	it("averages per task and per solved task, with calls, cache hit and time", () => {
		const models = treeModelSpend({ rootId: "root", sessions });
		const summary = efficiencySummary([
			{ solved: true, seconds: 600, models },
			{ solved: false, seconds: 300, models },
		]);
		const total = models.reduce((sum, row) => sum + (row.costUsd ?? 0), 0);
		expect(summary.tasks).toBe(2);
		expect(summary.perTaskUsd).toBeCloseTo(total);
		expect(summary.perSolvedUsd).toBeCloseTo(total * 2);
		expect(summary.callsPerTask).toBe(40);
		expect(summary.cacheHitRate).toBeCloseTo(1_350_000 / 1_650_000);
		expect(summary.secondsPerTask).toBe(450);
		expect(summary.models.find((row) => row.role === "builder")?.agents).toBe(
			2,
		);
		const lines = formatEfficiencyBlock("Arm review=on", summary);
		expect(lines[0]).toContain("1/2 solved");
		expect(lines[0]).toContain("40.0 calls/task");
		expect(lines[0]).toContain("cache hit 81.8%");
		expect(lines).toHaveLength(1 + summary.models.length);
	});

	it("keeps unknown dollars and uncounted calls unknown", () => {
		const summary = efficiencySummary([
			{
				solved: false,
				seconds: 10,
				models: [
					{
						role: "builder",
						model: "acme/x",
						agents: 1,
						requests: null,
						inputTokens: 10,
						outputTokens: 1,
						cacheReadTokens: 0,
						costUsd: null,
						estimated: false,
					},
				],
			},
		]);
		expect(summary.perTaskUsd).toBeNull();
		expect(summary.perSolvedUsd).toBeNull();
		expect(summary.callsPerTask).toBeNull();
		expect(formatEfficiencyBlock("x", summary)[0]).toContain("$?/task");
	});
});
