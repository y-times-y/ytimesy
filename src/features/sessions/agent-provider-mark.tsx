import { Plug } from "lucide-react";
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
		case "api":
			return <Plug size={size} aria-hidden="true" />;
		case "codex":
			return <CodexMark size={size} />;
	}
}
