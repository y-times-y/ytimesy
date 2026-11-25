import { describe, expect, it } from "vitest";
import type { SessionItem } from "./session-item";
import {
	heatmapDays,
	summarizeUsage,
	turnUsageFact,
	type UsageDailyRow,
	usageProvider,
} from "./usage-report";

const row = (over: Partial<UsageDailyRow>): UsageDailyRow => ({
	day: "2026-11-20",
	provider: "anthropic",
	modelId: "claude-sonnet-5-5",
	projectId: "p1",
	projectName: "acme/app",
	source: "box",
	turns: 1,
	unknownTurns: 0,
	inputTokens: 1000,
	outputTokens: 200,
	cacheReadTokens: 400,
	...over,
});

describe("usageProvider", () => {
	it.each([
		["claude-opus-5-5", null, "anthropic"],
		["gpt-5.5", null, "openai"],
		["o4-mini", null, "openai"],
		["grok-4.6", null, "xai"],
		["x-ai/grok-4.5", "openrouter", "xai"],
		["gemini-3-pro", null, "google"],
		["anthropic/claude-sonnet-5-5", "openrouter", "anthropic"],
		["deepseek-v4", "openrouter", "other"],
		["my-model", "google", "google"],
	])("%s via %s is %s", (model, connection, expected) => {
		expect(usageProvider(model, connection)).toBe(expected);
	});
});

describe("turnUsageFact", () => {
	const message = (apiUsage?: object): SessionItem =>
		({ kind: "userMessage", id: "u", text: "hi", apiUsage }) as SessionItem;
	it("reads the last user message's counts", () => {
		const fact = turnUsageFact([
			message(),
			message({
				inputTokens: 10,
				outputTokens: 5,
				cacheReadTokens: 4,
				uncachedInputTokens: 6,
				cacheWriteTokens: null,
			}),
		]);
		expect(fact).toEqual({
			inputTokens: 10,
			outputTokens: 5,
			cacheReadTokens: 4,
			known: true,
		});
	});
	it("marks a turn without counts unknown, not zero", () => {
		expect(turnUsageFact([message()]).known).toBe(false);
		expect(
			turnUsageFact([message({ inputTokens: null, outputTokens: null })]).known,
		).toBe(false);
		expect(turnUsageFact([]).known).toBe(false);
	});
});

describe("summarizeUsage", () => {
	const rows = [
		row({ day: "2026-11-25" }),
		row({
			day: "2026-11-20",
			provider: "openai",
			modelId: "gpt-5.5",
			inputTokens: 3000,
		}),
		row({ day: "2026-11-10", projectId: null, projectName: null }),
		row({
			day: "2026-10-20",
			unknownTurns: 1,
			inputTokens: 0,
			outputTokens: 0,
		}),
	];
	it("totals the range and compares with the period before", () => {
		const s = summarizeUsage(rows, "7d", "2026-11-25");
		expect(s.current.totalTokens).toBe(1200 + 3200);
		expect(s.current.cacheReadTokens).toBe(800);
		expect(s.previous?.totalTokens).toBe(0);
		expect(s.changeShare).toBeNull();
		const month = summarizeUsage(rows, "30d", "2026-11-25");
		expect(month.current.totalTokens).toBe(1200 + 3200 + 1200);
		expect(month.previous?.unknownTurns).toBe(1);
	});
	it("computes the change when the previous period had tokens", () => {
		const s = summarizeUsage(
			[
				row({ day: "2026-11-25", inputTokens: 1800 }),
				row({ day: "2026-11-17" }),
			],
			"7d",
			"2026-11-25",
		);
		expect(s.changeShare).toBeCloseTo((2000 - 1200) / 1200);
	});
	it("all time has no previous period", () => {
		const s = summarizeUsage(rows, "all", "2026-11-25");
		expect(s.previous).toBeNull();
		expect(s.current.turns).toBe(4);
		expect(s.current.unknownTurns).toBe(1);
	});
	it("breaks down by provider, model, project and source, largest first", () => {
		const s = summarizeUsage(rows, "30d", "2026-11-25");
		expect(s.byProvider.map((b) => b.key)).toEqual(["openai", "anthropic"]);
		expect(s.byModel[0]?.label).toBe("gpt-5.5");
		expect(s.byProject.map((b) => b.label)).toEqual(["acme/app", "No project"]);
		expect(s.byProject[0]?.totals.totalTokens).toBe(4400);
		expect(s.byProvider.reduce((n, b) => n + b.share, 0)).toBeCloseTo(1);
	});
});

describe("heatmapDays", () => {
	it("sums provider tokens and turns per day", () => {
		const days = heatmapDays([
			row({}),
			row({ provider: "openai", turns: 2, inputTokens: 50, outputTokens: 50 }),
		]);
		expect(days.get("2026-11-20")).toEqual({
			tokens: { anthropic: 1200, openai: 100 },
			turns: 3,
			unknownTurns: 0,
		});
	});
});
