import { codexSubscriptionModel } from "../adapters/codex-subscription";
import { type ModelAgentInput, runModelAgent } from "./api-agent-runtime";

/** Direct subscription transport shares the API harness loop and usage events; no native inference runner. */
export async function runCodexSubscriptionAgent(input: ModelAgentInput) {
	const runtime = await codexSubscriptionModel(
		input.userId,
		input.modelId,
		input.reasoning,
		input.fast,
	);
	return runModelAgent(input, runtime);
}
