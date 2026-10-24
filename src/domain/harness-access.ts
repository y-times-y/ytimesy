import type { AgentAuthMode, AgentConnection } from "./agent-connection";
import {
	type AgentProvider,
	type AgentProviderId,
	agentProviderById,
} from "./agent-provider";
import { parseModelRouteId } from "./model-connection";
import {
	isTurnRunning,
	type SessionItem,
	type SessionTurnStatus,
	sendWasQueued,
} from "./session-item";

type HarnessReadiness =
	| "ready"
	| "authorizing"
	| "unsigned"
	| "failed"
	| "expired";

type HarnessSubscriptionAction =
	| "sign_in"
	| "open_provider"
	| "retry"
	| "sign_in_again";

type HarnessAccess = {
	readonly provider: AgentProvider;
	readonly readiness: HarnessReadiness;
	readonly muted: boolean;
	readonly statusLabel: string;
	readonly summary: string;
	readonly subscriptionAction: HarnessSubscriptionAction | null;
	readonly subscriptionActionLabel: string | null;
	readonly userCode: string | null;
	readonly verificationUrl: string | null;
};

export function harnessAccess(
	provider: AgentProvider,
	connection: AgentConnection,
	options: { readonly codexSnapshotAvailable?: boolean } = {},
): HarnessAccess {
	const forThisProvider =
		connection.status !== "disconnected" && connection.provider === provider.id;
	if (forThisProvider && connection.status === "authenticated") {
		return readyAccess(provider, connection.authMode, connection.planType);
	}
	if (forThisProvider && connection.status === "awaiting_device_code") {
		return {
			provider,
			readiness: "authorizing",
			muted: true,
			statusLabel: "Authorizing",
			summary: connection.userCode
				? `Enter this code on ${provider.authorizeWith}`
				: `Open ${provider.authorizeWith} to finish signing in. If it shows a code, paste it here.`,
			subscriptionAction: "open_provider",
			subscriptionActionLabel: `Open ${provider.authorizeWith}`,
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
			userCode: null,
			verificationUrl: null,
		};
	}
	return unsignedAccess(provider, options);
}

export function harnessLoginIsPending(connection: AgentConnection): boolean {
	return connection.status === "awaiting_device_code";
}

/**
 * What a send does once connecting returned: send now, hold the message while
 * the user enters the device code (it is sent when sign-in completes), or drop it.
 */
export function sendAfterConnect(
	connection: AgentConnection,
): "send" | "await_sign_in" | "abandon" {
	if (connection.status === "authenticated") return "send";
	if (
		connection.status === "awaiting_device_code" &&
		connection.verificationUrl
	)
		return "await_sign_in";
	return "abandon";
}

/**
 * What the server's answer to a send means. The answer counts as sent only
 * when the chat it returns holds the message (by its id) or has a turn
 * running; any other answer left an optimistic "Thinking" with no turn behind
 * it, so it is reported and the message goes back to the composer.
 */
export function sendReplyOutcome(
	reply:
		| {
				readonly connection?: AgentConnection | null;
				readonly items: readonly SessionItem[];
				readonly turnStatus: SessionTurnStatus;
		  }
		| null
		| undefined,
	messageId: string,
):
	| { readonly kind: "sent" | "await_sign_in" }
	| { readonly kind: "failed"; readonly message: string } {
	// A refused request (an origin check, an expired session) has no view.
	if (!reply?.connection)
		return { kind: "failed", message: "The message could not be sent. Retry." };
	// The server refused the send; it reports why in place of the chat.
	if (reply.connection.status === "failed")
		return { kind: "failed", message: reply.connection.message };
	if (sendAfterConnect(reply.connection) === "await_sign_in")
		return { kind: "await_sign_in" };
	if (sendWasQueued(reply.items, messageId) || reply.turnStatus === "running")
		return { kind: "sent" };
	return {
		kind: "failed",
		message: "The message didn't reach the chat. Retry.",
	};
}

export function selectedHarnessIsConnected(
	connection: AgentConnection,
	harnessId: AgentProviderId,
): boolean {
	return (
		connection.status === "authenticated" && connection.provider === harnessId
	);
}

/** A Codex follow-up can resume while signed in (the saved login) even if the view looks disconnected. */
export function canResumeDisconnectedFollowUp(input: {
	readonly harnessId: AgentProviderId;
	readonly connection: AgentConnection;
	readonly turnStatus: SessionTurnStatus;
	readonly snapshotAvailable?: boolean;
}): boolean {
	if (isTurnRunning(input.turnStatus)) return false;
	if (input.connection.status !== "disconnected") return false;
	return input.harnessId === "codex" && Boolean(input.snapshotAvailable);
}

export const RUNNING_TURN_POLL_MS = 700;

export function composerCanStartSignIn(input: {
	readonly harnessId: AgentProviderId;
	readonly connection: AgentConnection;
	readonly snapshotAvailable?: boolean;
	readonly busy: boolean;
	readonly draft: string;
	readonly slashDraft: boolean;
}): boolean {
	if (input.busy || input.slashDraft || !input.draft.trim()) return false;
	if (!harnessRequiresAccountLogin(input.harnessId)) return false;
	if (selectedHarnessIsConnected(input.connection, input.harnessId)) {
		return false;
	}
	if (
		input.harnessId === "codex" &&
		input.connection.status === "disconnected" &&
		input.snapshotAvailable
	)
		return false;
	return input.connection.status !== "awaiting_device_code";
}

export function composerSendIsEnabled(input: {
	readonly harnessId: AgentProviderId;
	readonly connection: AgentConnection;
	readonly turnStatus: SessionTurnStatus;
	readonly snapshotAvailable?: boolean;
	readonly canSend: boolean;
	readonly busy: boolean;
	readonly draft: string;
	readonly modelId: string;
	readonly slashDraft: boolean;
}): boolean {
	if (input.busy || input.slashDraft || !input.draft.trim()) return false;
	if (composerCanStartSignIn(input)) return true;
	// A send during a run is queued for that run's next step.
	if (input.harnessId === "api")
		return parseModelRouteId(input.modelId) !== null;
	const harnessReady = selectedHarnessIsConnected(
		input.connection,
		input.harnessId,
	);
	const canResume = canResumeDisconnectedFollowUp(input);
	if (!harnessReady && !canResume) return false;
	if (harnessReady && !input.canSend && !canResume) return false;
	if (!canResume && !input.modelId) return false;
	return true;
}

/** Sign in is not a wall: show it while a code waits for approval or after a failed/expired login. Send starts a first login. */
export function harnessLoginShouldShow(input: {
	readonly harnessReady: boolean;
	readonly connection: AgentConnection;
	readonly harnessId: AgentProviderId;
}): boolean {
	if (input.harnessReady) return false;
	const access = harnessAccess(
		agentProviderById(input.harnessId),
		input.connection,
	);
	return (
		access.readiness === "authorizing" ||
		access.readiness === "failed" ||
		access.readiness === "expired"
	);
}

export function harnessRequiresAccountLogin(
	harnessId: AgentProviderId,
): boolean {
	return harnessId === "codex";
}

function readyAccess(
	provider: AgentProvider,
	authMode: AgentAuthMode,
	planType: string | null,
): HarnessAccess {
	return {
		provider,
		readiness: "ready",
		muted: false,
		statusLabel: authMode === "apikey" ? "API key" : "Signed in",
		summary:
			authMode === "apikey"
				? "Using a stored API key"
				: (planType ?? `Signed in with ${provider.signInMethod}`),
		subscriptionAction: null,
		subscriptionActionLabel: null,
		userCode: null,
		verificationUrl: null,
	};
}

function unsignedAccess(
	provider: AgentProvider,
	options: { readonly codexSnapshotAvailable?: boolean } = {},
): HarnessAccess {
	if (provider.id === "api")
		return {
			provider,
			readiness: "unsigned",
			muted: true,
			statusLabel: "Not connected",
			summary: "Add an API connection in Settings, then select a model.",
			subscriptionAction: null,
			subscriptionActionLabel: null,
			userCode: null,
			verificationUrl: null,
		};
	return {
		provider,
		readiness: "unsigned",
		muted: true,
		statusLabel: options.codexSnapshotAvailable
			? "Saved workspace"
			: "Not signed in",
		summary: options.codexSnapshotAvailable
			? "Resume ChatGPT from the saved workspace."
			: "Sign in with ChatGPT to use Codex.",
		subscriptionAction: "sign_in",
		subscriptionActionLabel: options.codexSnapshotAvailable
			? "Resume"
			: "Sign in",
		userCode: null,
		verificationUrl: null,
	};
}
