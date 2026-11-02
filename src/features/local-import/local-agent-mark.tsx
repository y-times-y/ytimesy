import type { LocalAgent } from "#/domain/local-import-view";
import { ClaudeMark } from "../sessions/claude-mark";
import { CodexMark } from "../sessions/codex-mark";
import { GrokMark } from "../sessions/grok-mark";
import { ModelProviderLogo } from "../sessions/model-provider-logo";

/**
 * A local coding agent's small mark: the bundled logos where ytimesy already
 * has them (Claude, Codex, Grok via xAI, Gemini), and plain monochrome marks
 * for OpenCode, Pi and Cursor (no copied brand art).
 */
export function LocalAgentMark({
	agent,
	size = 18,
}: {
	agent: LocalAgent;
	size?: number;
}) {
	switch (agent) {
		case "claude":
			return <ClaudeMark size={size} />;
		case "codex":
			return <CodexMark size={size} />;
		case "grok":
			return <GrokMark size={size} />;
		case "gemini":
			return <ModelProviderLogo provider="google" size={size} />;
		case "opencode":
			return (
				<svg
					width={size}
					height={size}
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					aria-hidden="true"
				>
					<rect x="4" y="3" width="16" height="18" rx="1.5" />
					<path d="M8 10h8v7H8z" fill="currentColor" stroke="none" />
				</svg>
			);
		case "pi":
			return (
				<svg
					width={size}
					height={size}
					viewBox="0 0 24 24"
					fill="currentColor"
					aria-hidden="true"
				>
					<path d="M3.5 6h17v2.6h-3.4V19h-2.8V8.6H9.9L9.1 19H6.3l.8-10.4H3.5z" />
				</svg>
			);
		case "cursor":
			return (
				<svg
					width={size}
					height={size}
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.8"
					strokeLinejoin="round"
					aria-hidden="true"
				>
					<path d="M12 2.5 20.5 7.25v9.5L12 21.5l-8.5-4.75v-9.5z" />
					<path d="M3.5 7.25 12 12l8.5-4.75M12 12v9.5" />
				</svg>
			);
	}
}
