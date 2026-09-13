import type { AgentProviderId } from "#/domain/agent-provider";
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
	}
}
