import type { AgentConnection } from "#/domain/agent-connection";
import {
	type AgentProvider,
	offeredAgentProviders,
} from "#/domain/agent-provider";

export type AgentProviderSetup = {
	readonly provider: AgentProvider;
	readonly detail: string;
	readonly actionLabel: string | null;
	readonly userCode: string | null;
	readonly verificationUrl: string | null;
};

export type AgentSetupContent = {
	readonly heading: "Connect an agent";
	readonly providers: readonly AgentProviderSetup[];
};

export function agentSetupContent(
	connection: AgentConnection,
	snapshotAvailable: boolean,
): AgentSetupContent | null {
	if (connection.status === "authenticated") return null;
	return {
		heading: "Connect an agent",
		providers: offeredAgentProviders().map((provider) =>
			providerSetup(provider, connection, snapshotAvailable),
		),
	};
}

function providerSetup(
	provider: AgentProvider,
	connection: AgentConnection,
	snapshotAvailable: boolean,
): AgentProviderSetup {
	const forThisProvider =
		connection.status !== "disconnected" && connection.provider === provider.id;
	if (forThisProvider && connection.status === "awaiting_device_code") {
		return {
			provider,
			detail: `Enter this code on ${provider.authorizeWith} to authorize this workspace.`,
			actionLabel: `Open ${provider.authorizeWith}`,
			userCode: connection.userCode,
			verificationUrl: connection.verificationUrl,
		};
	}
	if (forThisProvider && connection.status === "failed") {
		return {
			provider,
			detail: connection.message,
			actionLabel: "Try again",
			userCode: null,
			verificationUrl: null,
		};
	}
	if (forThisProvider && connection.status === "expired") {
		return {
			provider,
			detail: connection.message,
			actionLabel: "Sign in again",
			userCode: null,
			verificationUrl: null,
		};
	}
	return {
		provider,
		detail:
			snapshotAvailable && provider.id === "codex"
				? `Sign in with ${provider.signInMethod} to continue.`
				: `Sign in with ${provider.signInMethod}.`,
		actionLabel: "Sign in",
		userCode: null,
		verificationUrl: null,
	};
}
