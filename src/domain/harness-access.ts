import type { AgentAuthMode, AgentConnection } from "./agent-connection";
import {
	type AgentProvider,
	type AgentProviderId,
	offeredAgentProviders,
} from "./agent-provider";

export type HarnessReadiness =
	| "ready"
	| "authorizing"
	| "unsigned"
	| "failed"
	| "expired";

export type HarnessSubscriptionAction =
	| "sign_in"
	| "open_provider"
	| "retry"
	| "sign_in_again";

export type HarnessAccess = {
	readonly provider: AgentProvider;
	readonly readiness: HarnessReadiness;
	readonly muted: boolean;
	readonly statusLabel: string;
	readonly summary: string;
	readonly subscriptionAction: HarnessSubscriptionAction | null;
	readonly subscriptionActionLabel: string | null;
	readonly apiKeyHint: string | null;
	readonly userCode: string | null;
	readonly verificationUrl: string | null;
};

export function offeredHarnessAccess(
	connection: AgentConnection,
	apiKeyHints: Readonly<Partial<Record<AgentProviderId, string>>> = {},
): readonly HarnessAccess[] {
	return offeredAgentProviders().map((provider) =>
		harnessAccess(provider, connection, apiKeyHints[provider.id] ?? null),
	);
}

export function harnessAccess(
	provider: AgentProvider,
	connection: AgentConnection,
	apiKeyHint: string | null,
): HarnessAccess {
	const forThisProvider =
		connection.status !== "disconnected" && connection.provider === provider.id;
	if (forThisProvider && connection.status === "authenticated") {
		return readyAccess(
			provider,
			connection.authMode,
			connection.planType,
			apiKeyHint,
		);
	}
	if (forThisProvider && connection.status === "awaiting_device_code") {
		return {
			provider,
			readiness: "authorizing",
			muted: true,
			statusLabel: "Authorizing",
			summary: connection.userCode
				? `Enter this code on ${provider.authorizeWith}`
				: `Open ${provider.authorizeWith} to finish signing in. If it shows a code, paste it in Terminal.`,
			subscriptionAction: "open_provider",
			subscriptionActionLabel: `Open ${provider.authorizeWith}`,
			apiKeyHint,
			userCode: connection.userCode,
			verificationUrl: connection.verificationUrl,
		};
	}
	if (forThisProvider && connection.status === "failed") {
		return {
			provider,
			readiness: "failed",
			muted: true,
			statusLabel: "Failed",
			summary: connection.message,
			subscriptionAction: "retry",
			subscriptionActionLabel: "Try again",
			apiKeyHint,
			userCode: null,
			verificationUrl: null,
		};
	}
	if (forThisProvider && connection.status === "expired") {
		return {
			provider,
			readiness: "expired",
			muted: true,
			statusLabel: "Expired",
			summary: connection.message,
			subscriptionAction: "sign_in_again",
			subscriptionActionLabel: "Sign in again",
			apiKeyHint,
			userCode: null,
			verificationUrl: null,
		};
	}
	return unsignedAccess(provider, apiKeyHint);
}

export function selectedHarnessIsConnected(
	connection: AgentConnection,
	harnessId: AgentProviderId,
): boolean {
	return (
		connection.status === "authenticated" && connection.provider === harnessId
	);
}

function readyAccess(
	provider: AgentProvider,
	authMode: AgentAuthMode,
	planType: string | null,
	apiKeyHint: string | null,
): HarnessAccess {
	const usingKey = authMode === "apikey";
	return {
		provider,
		readiness: "ready",
		muted: false,
		statusLabel: usingKey ? "API key" : "Signed in",
		summary: usingKey
			? "Using a stored API key"
			: planType
				? planType
				: `Signed in with ${provider.signInMethod}`,
		subscriptionAction: null,
		subscriptionActionLabel: null,
		apiKeyHint,
		userCode: null,
		verificationUrl: null,
	};
}

function unsignedAccess(
	provider: AgentProvider,
	apiKeyHint: string | null,
): HarnessAccess {
	if (provider.id === "claude") {
		return {
			provider,
			readiness: "unsigned",
			muted: true,
			statusLabel: apiKeyHint ? "Key saved" : "Not signed in",
			summary: apiKeyHint
				? `Key ${apiKeyHint} is stored. Sign in with Claude Code so Anthropic can authenticate it.`
				: "Sign in with Claude Code on Anthropic's page, or paste an API key.",
			subscriptionAction: "sign_in",
			subscriptionActionLabel: "Sign in",
			apiKeyHint,
			userCode: null,
			verificationUrl: null,
		};
	}
	if (provider.id === "opencode") {
		return {
			provider,
			readiness: "unsigned",
			muted: true,
			statusLabel: apiKeyHint ? "Key saved" : "Not signed in",
			summary: apiKeyHint
				? `Key ${apiKeyHint} is stored. Sign in so OpenCode can connect it.`
				: "Sign in to OpenCode Zen, or paste a Zen or provider API key.",
			subscriptionAction: "sign_in",
			subscriptionActionLabel: "Sign in",
			apiKeyHint,
			userCode: null,
			verificationUrl: null,
		};
	}
	return {
		provider,
		readiness: "unsigned",
		muted: true,
		statusLabel: apiKeyHint ? "Key saved" : "Not signed in",
		summary: apiKeyHint
			? `Key ${apiKeyHint} is stored. Sign in with ChatGPT to use Codex.`
			: "Sign in with ChatGPT, or paste an API key.",
		subscriptionAction: "sign_in",
		subscriptionActionLabel: "Sign in",
		apiKeyHint,
		userCode: null,
		verificationUrl: null,
	};
}
