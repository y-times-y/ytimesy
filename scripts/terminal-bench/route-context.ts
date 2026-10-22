import type { ModelAgentRuntime } from "../../src/server/services/model-agent-loop";

/** The Sol context Codex's public Terminal-Bench job ran with. */
export const SOL_EVALUATION_CONTEXT_TOKENS = 272_000;

/**
 * The builder evaluator pins GPT-6.1 Sol's window to the public job's 272K
 * (the subscription catalog raised Sol's default on 2026-10-11) so either
 * Sol transport measures one harness. Claude routes keep their own window
 * (1M on Opus 5.5): forcing 272K would compact a Claude run four times too
 * early and, on a route without native compaction, end it ("Native
 * compaction is required ...").
 */
export function pinEvaluationContext(
	route: "bedrock-opus" | "openai-sol" | "codex-subscription",
	runtime: ModelAgentRuntime,
) {
	if (route === "bedrock-opus") return runtime;
	runtime.contextWindow = SOL_EVALUATION_CONTEXT_TOKENS;
	runtime.autoCompactTokenLimit = undefined;
	return runtime;
}
