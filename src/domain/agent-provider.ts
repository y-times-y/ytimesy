export type AgentProviderId = "codex" | "claude";

export type AgentProvider = {
	readonly id: AgentProviderId;
	readonly name: string;
	readonly signInMethod: string;
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
	name: "Claude",
	signInMethod: "Claude account",
	authorizeWith: "Anthropic",
};

export function offeredAgentProviders(): readonly AgentProvider[] {
	return [CODEX_PROVIDER, CLAUDE_PROVIDER];
}

export function agentProviderById(id: AgentProviderId): AgentProvider {
	switch (id) {
		case "codex":
			return CODEX_PROVIDER;
		case "claude":
			return CLAUDE_PROVIDER;
	}
}
