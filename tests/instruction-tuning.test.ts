import { describe, expect, it } from "vitest";
import type { InstructionProfile } from "#/domain/instruction-profiles";
import type { HardSetRecord } from "../scripts/hard-set/records";
import {
	geminiQuotaFromResponse,
	hardSetRoute,
	quotaStop,
	recordPricing,
} from "../scripts/hard-set/route";
import { HARD_SET } from "../scripts/hard-set/tasks";
import {
	batchesFor,
	rankVariants,
	recommendation,
	remainingTasks,
	roundEstimate,
	tuningRunName,
	tuningSchedule,
} from "../scripts/instruction-tuning/plan";

const PROFILES: InstructionProfile[] = [
	"baseline",
	"verify-hard",
	"plan-first",
	"persist",
	"concise",
];

function record(
	task: string,
	passed: boolean,
	extra: Partial<HardSetRecord> = {},
): HardSetRecord {
	return {
		model: "codex:gpt-6.1-sol",
		task,
		attempt: "1",
		category: HARD_SET.find((entry) => entry.id === task)?.category ?? "hard",
		mode: "agent",
		status: "final",
		state: "completed",
		reward: passed ? 1 : 0,
		passed,
		usageLimit: null,
		agentSec: 200,
		agentBudgetSec: 420,
		agentRequestedSec: 420,
		inputTokens: 200_000,
		cachedTokens: 180_000,
		outputTokens: 5_000,
		...extra,
	} as HardSetRecord;
}

describe("hard-set routes", () => {
	it("parses Codex and Gemini models", () => {
		expect(hardSetRoute("gpt-6.1-sol")).toEqual({
			kind: "codex",
			modelId: "gpt-6.1-sol",
			recordModel: "codex:gpt-6.1-sol",
		});
		expect(hardSetRoute("google/gemini-3.8-flash")).toEqual({
			kind: "google",
			modelId: "gemini-3.8-flash",
			recordModel: "google/gemini-3.8-flash",
		});
		expect(() => hardSetRoute("openai/gpt-6.1-sol")).toThrow(
			/Unexpected model/,
		);
		expect(recordPricing("google/gemini-3.8-flash").harness).toBe("api");
		expect(recordPricing("codex:gpt-6.1-sol").harness).toBe("codex");
	});

	it("stops on the Codex usage limit and on Gemini rate limits only for Gemini", () => {
		const codex = JSON.stringify([
			{
				kind: "error",
				text: "Your ChatGPT plan's Codex usage limit is used up. It resets in 2 h.",
			},
		]);
		expect(quotaStop("codex", codex)).toMatch(
			/^Your ChatGPT plan's Codex usage limit/,
		);
		const rate = JSON.stringify([
			{
				kind: "error",
				text: "The provider rate limit was reached (HTTP 429). Wait and retry.",
			},
		]);
		expect(quotaStop("google", rate)).toBe(
			"Gemini rate limit reached (HTTP 429)",
		);
		expect(quotaStop("codex", rate)).toBeNull();
		expect(quotaStop("google", "[]")).toBeNull();
	});

	it("reads Gemini 429 bodies into per-minute and daily quota states", () => {
		const body = (quotaId: string, retryDelay: string) =>
			JSON.stringify({
				error: {
					code: 429,
					details: [
						{
							"@type": "type.googleapis.com/google.rpc.QuotaFailure",
							violations: [{ quotaId, quotaValue: "5" }],
						},
						{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay },
					],
				},
			});
		expect(geminiQuotaFromResponse(200, "{}")).toEqual({ state: "ok" });
		expect(
			geminiQuotaFromResponse(
				429,
				body("GenerateRequestsPerMinutePerProjectPerModel-FreeTier", "22s"),
			),
		).toEqual({
			state: "limited",
			daily: false,
			retryAfterSec: 22,
			quotaIds: ["GenerateRequestsPerMinutePerProjectPerModel-FreeTier"],
		});
		expect(
			geminiQuotaFromResponse(
				429,
				body("GenerateRequestsPerDayPerProjectPerModel-FreeTier", "40000s"),
			),
		).toMatchObject({ state: "limited", daily: true });
		expect(geminiQuotaFromResponse(429, "not json")).toMatchObject({
			state: "limited",
			daily: false,
		});
		expect(geminiQuotaFromResponse(500, "")).toEqual({
			state: "error",
			status: 500,
		});
	});
});

describe("tuning schedule", () => {
	const schedule = tuningSchedule({
		prefix: "tune",
		models: ["gpt-6.1-sol", "google/gemini-3.8-flash"],
		variants: PROFILES,
		tasks: HARD_SET,
		repeats: 2,
	});

	it("runs every task under every profile once per repeat", () => {
		for (const model of ["gpt-6.1-sol", "google/gemini-3.8-flash"])
			for (const variant of PROFILES)
				for (const repeat of [1, 2]) {
					const tasks = schedule
						.filter(
							(job) =>
								job.model === model &&
								job.variant === variant &&
								job.repeat === repeat,
						)
						.flatMap((job) => job.tasks);
					expect(tasks.sort()).toEqual(HARD_SET.map((task) => task.id).sort());
				}
	});

	it("batches Codex by chunk and Gemini one task per invocation", () => {
		expect(
			batchesFor("gpt-6.1-sol", HARD_SET).every((batch) => batch.length <= 4),
		).toBe(true);
		expect(
			batchesFor("google/gemini-3.8-flash", HARD_SET).every(
				(batch) => batch.length === 1,
			),
		).toBe(true);
	});

	it("interleaves profiles per batch and rotates which goes first", () => {
		const codex = schedule.filter((job) => job.model === "gpt-6.1-sol");
		const firsts = new Set<string>();
		for (let index = 0; index < codex.length; index += PROFILES.length) {
			const group = codex.slice(index, index + PROFILES.length);
			expect(new Set(group.map((job) => job.variant)).size).toBe(
				PROFILES.length,
			);
			expect(new Set(group.map((job) => job.tasks.join())).size).toBe(1);
			firsts.add(group[0].variant);
		}
		expect(firsts.size).toBeGreaterThan(1);
		// Models alternate job by job.
		expect(schedule[0].model).toBe("gpt-6.1-sol");
		expect(schedule[1].model).toBe("google/gemini-3.8-flash");
	});

	it("names one hard-set run per model and profile", () => {
		expect(tuningRunName("tune", "google/gemini-3.8-flash", "persist")).toBe(
			"tune.google_gemini-3.8-flash.persist",
		);
		expect(() =>
			tuningRunName("bad prefix", "gpt-6.1-sol", "baseline"),
		).toThrow();
	});

	it("resumes: skips tasks whose repeat already has a scored or grading record", () => {
		const job = {
			model: "gpt-6.1-sol",
			variant: "baseline" as const,
			tasks: ["shadow-relay", "coq-block-bound", "interleaved-vigenere"],
			repeat: 1,
			run: "tune.gpt-6.1-sol.baseline",
		};
		expect(
			remainingTasks(job, [
				record("shadow-relay", true),
				record("coq-block-bound", false, { status: "grading", reward: null }),
				record("interleaved-vigenere", false, {
					usageLimit: "Codex usage limit reached",
				}),
			]),
		).toEqual(["interleaved-vigenere"]);
		expect(
			remainingTasks({ ...job, repeat: 2 }, [record("shadow-relay", true)]),
		).toEqual(job.tasks);
	});

	it("estimates a round per model", () => {
		const gpt = roundEstimate("gpt-6.1-sol", schedule);
		expect(gpt.taskRuns).toBe(HARD_SET.length * PROFILES.length * 2);
		expect(gpt.codexWindowPercent?.[0]).toBeCloseTo(gpt.taskRuns * 1.5);
		const gemini = roundEstimate("google/gemini-3.8-flash", schedule);
		expect(gemini.codexWindowPercent).toBeNull();
		expect(gemini.invocations).toBe(gemini.taskRuns);
		expect(gemini.wallHours).toBeGreaterThan(gpt.wallHours);
	});
});

describe("ranking", () => {
	const tasks = HARD_SET.slice(0, 10).map((task) => task.id);
	const run = (passes: number, extra: Partial<HardSetRecord> = {}) =>
		tasks.map((task, index) => record(task, index < passes, extra));

	it("ranks on the tasks every profile scored and ignores unscored records", () => {
		const ranked = rankVariants(
			new Map<InstructionProfile, HardSetRecord[]>([
				["baseline", run(4)],
				["persist", run(5)],
				[
					"concise",
					[
						...run(3),
						record("extra-task", true),
						record(tasks[5], true, { usageLimit: "limit", attempt: "2" }),
					],
				],
			]),
		);
		expect(ranked.map((row) => row.variant)).toEqual([
			"persist",
			"baseline",
			"concise",
		]);
		expect(ranked[0]).toMatchObject({
			passed: 5,
			scored: 10,
			wins: 1,
			losses: 0,
		});
		expect(ranked[0].commonRate).toBeCloseTo(0.5);
		expect(ranked[0].costPerSolved).toBeGreaterThan(0);
		expect(ranked.find((row) => row.variant === "concise")?.scored).toBe(11);
	});

	it("calls 1-2 task differences noise and wants repeats before adopting", () => {
		const rank = (baseline: number, persist: number) =>
			rankVariants(
				new Map<InstructionProfile, HardSetRecord[]>([
					["baseline", run(baseline)],
					["persist", run(persist)],
				]),
			);
		expect(recommendation(rank(4, 6), 10, 3)).toMatch(
			/^Keep baseline: .*noise/,
		);
		expect(recommendation(rank(4, 8), 10, 1)).toMatch(/^Promising/);
		expect(recommendation(rank(4, 8), 10, 3)).toMatch(/^Adopt persist/);
		expect(recommendation(rank(6, 4), 10, 3)).toMatch(
			/^Keep baseline: no profile/,
		);
	});
});
