export type AgentProviderId = "codex" | "claude" | "opencode";

export type AgentProvider = {
	readonly id: AgentProviderId;
	readonly name: string;
	readonly signInMethod: string | null;
	readonly authorizeWith: string;
};

export const CODEX_PROVIDER: AgentProvider = {
	id: "codex",
	name: "Codex",
	signInMethod: "ChatGPT",
	authorizeWith: "OpenAI",
};

export const CLAUDE_PROVIDER: AgentProvider = {
	id: "claude",
	name: "Claude Code",
	signInMethod: "Claude account",
	authorizeWith: "Anthropic",
};

export const OPENCODE_PROVIDER: AgentProvider = {
	id: "opencode",
	name: "OpenCode",
	signInMethod: null,
	authorizeWith: "workspace",
};

export function offeredAgentProviders(): readonly AgentProvider[] {
	return [CODEX_PROVIDER, CLAUDE_PROVIDER, OPENCODE_PROVIDER];
}

export function agentProviderById(id: AgentProviderId): AgentProvider {
	switch (id) {
		case "codex":
			return CODEX_PROVIDER;
		case "claude":
			return CLAUDE_PROVIDER;
		case "opencode":
			return OPENCODE_PROVIDER;
	}
}
