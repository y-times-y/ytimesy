import { knownModelLimits } from "../../src/domain/model-context-windows";
import { UNKNOWN_CONTEXT_WINDOW } from "../../src/server/services/api-agent-context";
import type { ModelAgentRuntime } from "../../src/server/services/model-agent-loop";
import { bedrockAnthropicProfile } from "./bedrock";
import type { HarborBridgeConfig } from "./config";

/** What a trial runs on, for the bridge log: `context window <n> (<source>)` and its native compaction. */
export function describeRuntime(
	runtime: ModelAgentRuntime,
	config: HarborBridgeConfig,
) {
	const source =
		runtime.contextWindow === undefined
			? "fallback"
			: config.route === "bedrock" && bedrockAnthropicProfile(config.modelId)
				? "stated"
				: runtime.contextWindow ===
						knownModelLimits(config.modelId)?.contextWindow
					? "checked-in"
					: "provider";
	const compaction = !runtime.compact
		? "off"
		: config.route === "bedrock"
			? bedrockAnthropicProfile(config.modelId)
				? "anthropic"
				: "openai-v2 (in-stream) + openai-v1 (compact endpoint), own-summary fallback"
			: "on";
	return [
		`context window ${runtime.contextWindow ?? UNKNOWN_CONTEXT_WINDOW} (${source})`,
		`native compaction ${compaction}`,
	];
}
