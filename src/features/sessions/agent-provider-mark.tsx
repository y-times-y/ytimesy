import type { AgentProviderId } from "#/domain/agent-provider";
import { ClaudeMark } from "./claude-mark";
import { CodexMark } from "./codex-mark";

export function AgentProviderMark({
	provider,
	size = 24,
}: {
	provider: AgentProviderId;
	size?: number;
}) {
	switch (provider) {
		case "codex":
			return <CodexMark size={size} />;
		case "claude":
			return <ClaudeMark size={size} />;
	}
}
