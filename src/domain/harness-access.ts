import type { AgentAuthMode, AgentConnection } from "./agent-connection";
import {
	type AgentProvider,
	type AgentProviderId,
	offeredAgentProviders,
} from "./agent-provider";
import { isTurnRunning, type SessionTurnStatus } from "./session-item";

export type HarnessReadiness =
	| "ready"
	| "authorizing"
	| "unsigned"
	| "failed"
	| "expired";

export type HarnessSubscriptionAction =
	| "sign_in"
	| "connect"
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
	options: { readonly codexSnapshotAvailable?: boolean } = {},
): readonly HarnessAccess[] {
	return offeredAgentProviders().map((provider) =>
		harnessAccess(
			provider,
			connection,
			apiKeyHints[provider.id] ?? null,
			options,
		),
	);
}

export function harnessAccess(
	provider: AgentProvider,
	connection: AgentConnection,
	apiKeyHint: string | null,
	options: { readonly codexSnapshotAvailable?: boolean } = {},
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
	return unsignedAccess(provider, apiKeyHint, options);
}

export function selectedHarnessIsConnected(
	connection: AgentConnection,
	harnessId: AgentProviderId,
): boolean {
	return (
		connection.status === "authenticated" && connection.provider === harnessId
	);
}

export function shouldAutoResumeHarnessSession(input: {
	readonly harnessId: AgentProviderId;
	readonly connection: AgentConnection;
}): boolean {
	if (input.harnessId === "claude") return false;
	return selectedHarnessIsConnected(input.connection, input.harnessId);
}

/**
 * Selecting a paused chat must not boot its VM. Typing a follow-up should:
 * OpenCode can connect without an account; Codex can resume a saved workspace;
 * Claude still needs an explicit Anthropic sign-in.
 */
export function canResumeDisconnectedFollowUp(input: {
	readonly harnessId: AgentProviderId;
	readonly connection: AgentConnection;
	readonly turnStatus: SessionTurnStatus;
	readonly snapshotAvailable?: boolean;
}): boolean {
	if (isTurnRunning(input.turnStatus)) return false;
	if (input.connection.status !== "disconnected") return false;
	if (input.harnessId === "claude") return false;
	if (input.harnessId === "codex") return Boolean(input.snapshotAvailable);
	return input.harnessId === "opencode";
}

export function harnessRequiresAccountLogin(
	harnessId: AgentProviderId,
): boolean {
	return harnessId !== "opencode";
}

function readyAccess(
	provider: AgentProvider,
	authMode: AgentAuthMode,
	planType: string | null,
	apiKeyHint: string | null,
): HarnessAccess {
	if (authMode === "apikey") {
		return {
			provider,
			readiness: "ready",
			muted: false,
			statusLabel: "API key",
			summary: "Using a stored API key",
			subscriptionAction: null,
			subscriptionActionLabel: null,
			apiKeyHint,
			userCode: null,
			verificationUrl: null,
		};
	}
	if (authMode === "local") {
		return {
			provider,
			readiness: "ready",
			muted: false,
			statusLabel: "Connected",
			summary: planType ?? "Running on this workspace",
			subscriptionAction: null,
			subscriptionActionLabel: null,
			apiKeyHint,
			userCode: null,
			verificationUrl: null,
		};
	}
	return {
		provider,
		readiness: "ready",
		muted: false,
		statusLabel: "Signed in",
		summary: planType
			? planType
			: provider.signInMethod
				? `Signed in with ${provider.signInMethod}`
				: "Running on this workspace",
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
	options: { readonly codexSnapshotAvailable?: boolean } = {},
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
			statusLabel: apiKeyHint ? "Key saved" : "Not connected",
			summary: apiKeyHint
				? `Key ${apiKeyHint} is stored. Connect OpenCode to attach it. No account is required.`
				: "Connect OpenCode on the workspace. No account is required. Paste a provider key only if you want extra models.",
			subscriptionAction: "connect",
			subscriptionActionLabel: "Connect",
			apiKeyHint,
			userCode: null,
			verificationUrl: null,
		};
	}
	return {
		provider,
		readiness: "unsigned",
		muted: true,
		statusLabel: options.codexSnapshotAvailable
			? "Saved workspace"
			: apiKeyHint
				? "Key saved"
				: "Not signed in",
		summary: options.codexSnapshotAvailable
			? "Resume ChatGPT from the saved workspace."
			: apiKeyHint
				? `Key ${apiKeyHint} is stored. Sign in with ChatGPT to use Codex.`
				: "Sign in with ChatGPT, or paste an API key.",
		subscriptionAction: "sign_in",
		subscriptionActionLabel: options.codexSnapshotAvailable
			? "Resume"
			: "Sign in",
		apiKeyHint,
		userCode: null,
		verificationUrl: null,
	};
}
