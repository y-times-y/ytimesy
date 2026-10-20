import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { FailoverConnection } from "#/domain/model-failover";
import {
	CLASSIFIER_INSTRUCTIONS,
	type ClassifierInput,
	classifierMessage,
} from "#/domain/sidekick-classifier";
import { classifySidekick } from "./sidekick-classifier";

const routes = vi.fn(
	async (): Promise<FailoverConnection[]> => [
		{
			key: "codex",
			label: "Codex",
			kind: "subscription",
			revision: "",
			models: [
				{ id: "gpt-6-luna", label: "GPT-6 Luna", reasoning: ["low", "high"] },
				{ id: "gpt-6.1-sol", label: "GPT-6.1 Sol" },
			],
		},
	],
);

const summary: ClassifierInput = {
	point: "round",
	round: 2,
	roundKind: "build",
	model: "gpt-6-luna",
	brief: "Fix make test.",
	report: "Still failing.",
	commands: [{ command: "make test", exitCode: 2 }],
	signals: [{ kind: "same-check-failed", detail: "make test" }],
	canSwitch: true,
};

const usage = {
	inputTokens: 900,
	inputTokenDetails: {
		noCacheTokens: 900,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
	},
	outputTokens: 30,
	outputTokenDetails: { textTokens: 30, reasoningTokens: 0 },
	totalTokens: 930,
} as never;

function classify(
	call: Parameters<typeof classifySidekick>[0]["deps"] extends infer D
		? D extends { call?: infer C }
			? C
			: never
		: never,
	roleModels = {},
) {
	let clock = 1_000;
	return classifySidekick({
		userId: "user",
		roleModels,
		summary,
		deps: { routes, call, now: () => (clock += 40), timeoutMs: 50 },
	});
}

describe("classifySidekick", () => {
	it("asks gpt-6-luna at low effort by default and records the decision", async () => {
		const call = vi.fn(async () => ({
			text: '{"decision":"switch_model","reason":"repeats make test"}',
			usage,
		}));
		const { answer, record } = await classify(call);
		expect(answer).toEqual({
			decision: "switch_model",
			reason: "repeats make test",
		});
		expect(call).toHaveBeenCalledWith(
			expect.objectContaining({
				model: expect.objectContaining({
					harness: "codex",
					listedModelId: "gpt-6-luna",
					reasoning: "low",
				}),
				instructions: CLASSIFIER_INSTRUCTIONS,
				message: classifierMessage(summary),
			}),
		);
		expect(record).toMatchObject({
			point: "round",
			round: 2,
			decision: "switch_model",
			source: "classifier",
			inputsHash: createHash("sha256")
				.update(classifierMessage(summary))
				.digest("hex"),
			latencyMs: 40,
			tokens: 930,
			planBilled: true,
			model: "gpt-6-luna",
		});
		expect(record.fallback).toBeUndefined();
	});

	it("falls back to the rules on an unparsable reply, a failure, a timeout or no route", async () => {
		const unparsable = await classify(
			vi.fn(async () => ({ text: "It looks stuck to me.", usage })),
		);
		expect(unparsable.record).toMatchObject({
			source: "rules",
			decision: "switch_model",
			fallback: "unparsable reply: It looks stuck to me.",
			tokens: 930,
		});
		const failed = await classify(
			vi.fn(async () => {
				throw new Error("502 from the provider");
			}),
		);
		expect(failed.record).toMatchObject({
			source: "rules",
			fallback: "failed: 502 from the provider",
			tokens: 0,
		});
		const slow = await classify(
			vi.fn(
				(input: { signal: AbortSignal }) =>
					new Promise<never>((_, reject) =>
						input.signal.addEventListener("abort", () =>
							reject(input.signal.reason),
						),
					),
			),
		);
		expect(slow.record).toMatchObject({
			source: "rules",
			fallback: "timed out",
		});
		const noRoute = await classify(vi.fn(), {
			classifier: { model: "api:google/gemini-3.8-flash" },
		});
		expect(noRoute.record.source).toBe("rules");
		expect(noRoute.record.fallback).toContain("not available");
	});

	it("turns a switch_model it cannot carry out into a hand_back", async () => {
		const { answer } = await classifySidekick({
			userId: "user",
			roleModels: {},
			summary: { ...summary, canSwitch: false },
			deps: {
				routes,
				call: vi.fn(async () => ({
					text: '{"decision":"switch_model","reason":"stuck"}',
					usage,
				})),
			},
		});
		expect(answer.decision).toBe("hand_back");
	});
});
