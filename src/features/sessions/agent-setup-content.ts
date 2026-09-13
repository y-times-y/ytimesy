import type { AgentConnection } from "#/domain/agent-connection";

export type AgentSetupContent = {
	readonly title: "Codex";
	readonly detail: string;
	readonly actionLabel: string | null;
	readonly userCode: string | null;
	readonly verificationUrl: string | null;
};

export function agentSetupContent(
	connection: AgentConnection,
	snapshotAvailable: boolean,
): AgentSetupContent | null {
	if (connection.status === "authenticated") return null;
	if (connection.status === "awaiting_device_code") {
		return {
			title: "Codex",
			detail: "Enter this code on OpenAI to authorize this workspace.",
			actionLabel: "Open OpenAI",
			userCode: connection.userCode,
			verificationUrl: connection.verificationUrl,
		};
	}
	if (connection.status === "failed") {
		return {
			title: "Codex",
			detail: connection.message,
			actionLabel: "Try again",
			userCode: null,
			verificationUrl: null,
		};
	}
	if (connection.status === "expired") {
		return {
			title: "Codex",
			detail: connection.message,
			actionLabel: "Sign in again",
			userCode: null,
			verificationUrl: null,
		};
	}
	return {
		title: "Codex",
		detail: snapshotAvailable
			? "Sign in with ChatGPT to continue."
			: "Sign in with ChatGPT to use Codex in this workspace.",
		actionLabel: "Sign in",
		userCode: null,
		verificationUrl: null,
	};
}
