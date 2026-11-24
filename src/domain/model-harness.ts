import type { AgentProviderId } from "./agent-provider";
import { isClaudeCodeRoute } from "./claude-code-route";

/**
 * Which harness a model id belongs to: API-key routes (`api/…`) and the
 * Claude plan (`claude-code/…`) are "api"; every other id is a Codex (ChatGPT
 * plan) model. Null for an empty id, which names no model.
 */
export function harnessForModelId(modelId: string): AgentProviderId | null {
	if (!modelId) return null;
	return modelId.startsWith("api/") || isClaudeCodeRoute(modelId)
		? "api"
		: "codex";
}
