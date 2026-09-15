import { Effect } from "effect";
import type { AgentConnection } from "#/domain/agent-connection";
import {
	type AgentProviderId,
	agentProviderById,
} from "#/domain/agent-provider";
import { WorkspaceId } from "#/domain/ids";
import {
	harnessConnectBlockedReason,
	workspaceSessionMachineRef,
} from "#/domain/project-workspace";
import { canSubmitComposer, canSubmitSideChat } from "#/domain/session-policy";
import type { WorkspaceLifecycle } from "#/domain/workspace";
import {
	type ClaudeAuthStatus,
	connectClaudeCode,
	refreshClaudeAuthStatus,
	submitClaudeTask,
} from "#/server/adapters/claude/login-session";
import {
	connectOpenCode,
	type OpenCodeAuthStatus,
	refreshOpenCodeAuthStatus,
	submitOpenCodeTask,
} from "#/server/adapters/opencode/serve-session";
import { readyWorkspaceForOwner } from "#/server/adapters/workspaces";
import { decryptHarnessApiKey } from "#/server/secrets/harness-key-store";
import {
	type CodexSessionScope,
	connectCodexWorkspaceSession,
	emptyCodexSession,
	type PublicCodexSession,
	readCodexWorkspaceSession,
	sendCodexWorkspaceTask,
	stopCodexWorkspaceTurn,
} from "./codex-workspace-session";
import type { WorkspaceMachines } from "./workspace-machines";

export type HarnessSessionScope = CodexSessionScope & {
	readonly harnessId: AgentProviderId;
};

export type PublicHarnessSession = PublicCodexSession;

export function emptyHarnessSession(
	snapshotAvailable = false,
): PublicHarnessSession {
	return emptyCodexSession(snapshotAvailable);
}

export function readHarnessWorkspaceSession(
	machines: WorkspaceMachines,
	scope: HarnessSessionScope,
): Effect.Effect<PublicHarnessSession> {
	if (scope.harnessId === "codex") {
		return readCodexWorkspaceSession(machines, scope);
	}
	return withPreparedMachine(machines, scope, (providerRef) => {
		if (scope.harnessId === "claude") {
			return refreshClaudeAuthStatus(machines, WorkspaceId(providerRef)).pipe(
				Effect.map((status) => viewFromClaude(status, providerRef)),
			);
		}
		return refreshOpenCodeAuthStatus(machines, WorkspaceId(providerRef)).pipe(
			Effect.map((status) => viewFromOpenCode(status, providerRef)),
		);
	});
}

/**
 * Starts the selected harness on the prepared workspace VM. Stored keys are
 * passed to the unmodified CLI or `opencode serve` and never count as signed
 * in on their own.
 */
export function connectHarnessWorkspaceSession(
	machines: WorkspaceMachines,
	scope: HarnessSessionScope,
): Effect.Effect<PublicHarnessSession> {
	if (scope.harnessId === "codex") {
		return connectCodexWorkspaceSession(machines, scope);
	}
	const harnessName = agentProviderById(scope.harnessId).name;
	return Effect.gen(function* () {
		const workspace = yield* Effect.tryPromise(() =>
			readyWorkspaceForOwner(scope.userId, scope.projectId),
		);
		const blocked = harnessConnectBlockedReason(
			workspace,
			harnessName,
			scope.harnessId === "opencode" ? "connect" : "sign_in",
		);
		if (blocked || !workspace?.providerRef) {
			return {
				...emptyHarnessSession(),
				connection: {
					status: "failed" as const,
					provider: scope.harnessId,
					message:
						blocked ??
						(scope.harnessId === "opencode"
							? `Prepare a workspace before connecting ${harnessName}.`
							: `Prepare a workspace before signing in to ${harnessName}.`),
				},
			};
		}
		yield* Effect.tryPromise(() =>
			machines.ensureRunning(WorkspaceId(workspace.providerRef as string)),
		);
		const apiKey = yield* Effect.tryPromise(() =>
			decryptHarnessApiKey(scope.harnessId),
		);
		if (scope.harnessId === "claude") {
			const status = yield* connectClaudeCode(
				machines,
				WorkspaceId(workspace.providerRef),
				apiKey,
			);
			return viewFromClaude(status, workspace.providerRef);
		}
		const status = yield* connectOpenCode(
			machines,
			WorkspaceId(workspace.providerRef),
			apiKey,
		);
		return viewFromOpenCode(status, workspace.providerRef);
	}).pipe(
		Effect.catchAll((cause) =>
			Effect.succeed({
				...emptyHarnessSession(),
				connection: {
					status: "failed" as const,
					provider: scope.harnessId,
					message: cause instanceof Error ? cause.message : String(cause),
				},
			}),
		),
	);
}

export function sendHarnessWorkspaceTask(
	machines: WorkspaceMachines,
	scope: HarnessSessionScope,
	input: {
		readonly text: string;
		readonly modelId: string;
		readonly lane?: "main" | "side";
	},
): Effect.Effect<PublicHarnessSession> {
	if (scope.harnessId === "codex") {
		return sendCodexWorkspaceTask(machines, scope, input);
	}
	return withPreparedMachine(machines, scope, (providerRef) => {
		if (scope.harnessId === "claude") {
			return submitClaudeTask(machines, WorkspaceId(providerRef), input).pipe(
				Effect.map((status) => viewFromClaude(status, providerRef)),
			);
		}
		return submitOpenCodeTask(machines, WorkspaceId(providerRef), input).pipe(
			Effect.map((status) => viewFromOpenCode(status, providerRef)),
		);
	});
}

export function stopHarnessWorkspaceTurn(
	machines: WorkspaceMachines,
	scope: HarnessSessionScope,
): Effect.Effect<PublicHarnessSession> {
	if (scope.harnessId === "codex") {
		return stopCodexWorkspaceTurn(machines, scope);
	}
	return readHarnessWorkspaceSession(machines, scope);
}

function withPreparedMachine(
	machines: WorkspaceMachines,
	scope: HarnessSessionScope,
	run: (providerRef: string) => Effect.Effect<PublicHarnessSession>,
): Effect.Effect<PublicHarnessSession> {
	return Effect.gen(function* () {
		const workspace = yield* Effect.tryPromise(() =>
			readyWorkspaceForOwner(scope.userId, scope.projectId),
		);
		const providerRef = workspaceSessionMachineRef(workspace);
		if (!providerRef) return emptyHarnessSession();
		yield* Effect.tryPromise(() =>
			machines.ensureRunning(WorkspaceId(providerRef)),
		);
		return yield* run(providerRef);
	}).pipe(
		Effect.catchAll((cause) =>
			Effect.succeed({
				...emptyHarnessSession(),
				connection: {
					status: "failed" as const,
					provider: scope.harnessId,
					message: cause instanceof Error ? cause.message : String(cause),
				},
			}),
		),
	);
}

function viewFromClaude(
	status: ClaudeAuthStatus,
	workspaceId: string,
): PublicHarnessSession {
	return viewFromConnection(
		connectionFromClaude(status),
		workspaceId,
		status.stage === "authenticated" ? status.models : [],
		status.stage === "authenticated" ? status.turnStatus : "idle",
		status.stage === "authenticated" ? status.items : [],
	);
}

function viewFromOpenCode(
	status: OpenCodeAuthStatus,
	workspaceId: string,
): PublicHarnessSession {
	return viewFromConnection(
		connectionFromOpenCode(status),
		workspaceId,
		status.stage === "authenticated" ? status.models : [],
		status.stage === "authenticated" ? status.turnStatus : "idle",
		status.stage === "authenticated" ? status.items : [],
	);
}

function viewFromConnection(
	connection: AgentConnection,
	workspaceId: string,
	models: PublicHarnessSession["models"],
	turnStatus: PublicHarnessSession["turnStatus"],
	items: PublicHarnessSession["items"],
): PublicHarnessSession {
	const workspace: WorkspaceLifecycle = {
		status: "running",
		workspaceId: WorkspaceId(workspaceId),
	};
	return {
		snapshotAvailable: false,
		workspaceId,
		connection,
		models,
		canSend: canSubmitComposer(workspace, connection, turnStatus),
		canSendSide: canSubmitSideChat(workspace, connection, "idle"),
		turnStatus,
		items,
		sideTurnStatus: "idle",
		sideItems: [],
	};
}

function connectionFromClaude(status: ClaudeAuthStatus): AgentConnection {
	if (status.stage === "authenticated") {
		return {
			status: "authenticated",
			provider: "claude",
			authMode: status.authMode,
			planType: status.planType,
			email: null,
		};
	}
	if (status.stage === "awaiting_device_code") {
		return {
			status: "awaiting_device_code",
			provider: "claude",
			loginId: status.loginId,
			verificationUrl: status.verificationUrl,
			userCode: "",
		};
	}
	if (status.stage === "failed") {
		return {
			status: "failed",
			provider: "claude",
			message: status.message,
		};
	}
	return { status: "disconnected" };
}

function connectionFromOpenCode(status: OpenCodeAuthStatus): AgentConnection {
	if (status.stage === "authenticated") {
		return {
			status: "authenticated",
			provider: "opencode",
			authMode: status.authMode,
			planType: status.planType,
			email: null,
		};
	}
	if (status.stage === "failed") {
		return {
			status: "failed",
			provider: "opencode",
			message: status.message,
		};
	}
	return { status: "disconnected" };
}
