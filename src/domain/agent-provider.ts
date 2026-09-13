export type AgentProviderId = "codex";

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

export function offeredAgentProviders(): readonly AgentProvider[] {
	return [CODEX_PROVIDER];
}

export function agentProviderById(id: AgentProviderId): AgentProvider {
	switch (id) {
		case "codex":
			return CODEX_PROVIDER;
	}
}
