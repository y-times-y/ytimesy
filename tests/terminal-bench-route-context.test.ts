import { describe, expect, it } from "vitest";
import {
	pinEvaluationContext,
	SOL_EVALUATION_CONTEXT_TOKENS,
} from "../scripts/terminal-bench/route-context";
import type { ModelAgentRuntime } from "../src/server/services/model-agent-loop";

const runtime = (): ModelAgentRuntime => ({
	model: "fixture",
	contextWindow: 1_000_000,
	autoCompactTokenLimit: 900_000,
});

describe("pinEvaluationContext", () => {
	it("pins both Sol transports to the public job's 272K", () => {
		for (const route of ["openai-sol", "codex-subscription"] as const) {
			const pinned = pinEvaluationContext(route, runtime());
			expect(pinned.contextWindow).toBe(SOL_EVALUATION_CONTEXT_TOKENS);
			expect(pinned.autoCompactTokenLimit).toBeUndefined();
		}
	});

	it("leaves a Claude route's own window alone", () => {
		const pinned = pinEvaluationContext("bedrock-opus", runtime());
		expect(pinned.contextWindow).toBe(1_000_000);
		expect(pinned.autoCompactTokenLimit).toBe(900_000);
	});
});
