/**
 * How a root chat works. "builder" (launch default): the chat edits its own
 * workspace with the builder profile, the configuration we benchmark.
 * "lead": a read-only lead that delegates to builder tasks. Fusion is chosen
 * separately when a sidekick model is configured.
 */
type RootAgentMode = "builder" | "lead";

export function rootAgentMode(
	value = process.env.YTIMESY_ROOT_AGENT_MODE,
): RootAgentMode {
	return value?.trim() === "lead" ? "lead" : "builder";
}
