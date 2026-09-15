import { Effect } from "effect";
import type { AgentConnection } from "#/domain/agent-connection";
import { WorkspaceId } from "#/domain/ids";
import {
	codexConnectBlockedReason,
	workspaceSessionMachineRef,
} from "#/domain/project-workspace";
import type { SessionItem, SessionTurnStatus } from "#/domain/session-item";
import { canSubmitComposer, canSubmitSideChat } from "#/domain/session-policy";
import type { WorkspaceLifecycle } from "#/domain/workspace";
import {
	interruptCodexTurn,
	readLoginStatus,
	resumeCodexSession,
	startInteractiveDeviceCodeLogin,
	submitCodexTask,
} from "#/server/adapters/codex/login-session";
import type {
	CodexLoginStatus,
	ListedModel,
} from "#/server/adapters/codex/login-status";
import { readyWorkspaceForOwner } from "#/server/adapters/workspaces";
import { loadAgentSnapshotId } from "#/server/auth/agent-account";
import { persistCodexAuthSnapshotForUser } from "#/server/proof/persist-codex-auth-snapshot";
import type { WorkspaceMachines } from "./workspace-machines";

export type PublicCodexSession = {
	readonly snapshotAvailable: boolean;
	readonly workspaceId: string | null;
	readonly connection: AgentConnection;
	readonly models: readonly ListedModel[];
	readonly canSend: boolean;
	readonly canSendSide: boolean;
	readonly turnStatus: SessionTurnStatus;
	readonly items: readonly SessionItem[];
	readonly sideTurnStatus: SessionTurnStatus;
	readonly sideItems: readonly SessionItem[];
};

export type CodexSessionScope = {
	readonly userId: string;
	readonly projectId?: string;
};

const disconnected: AgentConnection = { status: "disconnected" };

export function emptyCodexSession(
	snapshotAvailable = false,
): PublicCodexSession {
	return {
		snapshotAvailable,
		workspaceId: null,
		connection: disconnected,
		models: [],
		canSend: false,
		canSendSide: false,
		turnStatus: "idle",
		items: [],
		sideTurnStatus: "idle",
		sideItems: [],
	};
}

/**
 * Reads Codex on the signed-in user's prepared workspace. Missing machines
 * become a disconnected session so the homepage can render.
 */
export function readCodexWorkspaceSession(
	machines: WorkspaceMachines,
	scope: CodexSessionScope,
): Effect.Effect<PublicCodexSession> {
	return Effect.gen(function* () {
		const snapshotId = yield* Effect.tryPromise(() =>
			loadAgentSnapshotId(scope.userId),
		);
		const workspace = yield* Effect.tryPromise(() =>
			readyWorkspaceForOwner(scope.userId, scope.projectId),
		);
		const providerRef = workspaceSessionMachineRef(workspace);
		if (!providerRef) {
			return emptyCodexSession(Boolean(snapshotId));
		}
		yield* Effect.tryPromise(() =>
			machines.ensureRunning(WorkspaceId(providerRef)),
		);
		const status = yield* readLoginStatus(machines, WorkspaceId(providerRef));
		return viewFromStatus(status, providerRef, Boolean(snapshotId));
	}).pipe(
		Effect.catchAll(() =>
			Effect.tryPromise(() => loadAgentSnapshotId(scope.userId)).pipe(
				Effect.map((snapshotId) => emptyCodexSession(Boolean(snapshotId))),
				Effect.catchAll(() => Effect.succeed(emptyCodexSession())),
			),
		),
	);
}

/**
 * Recovers the prepared project VM and starts or resumes Codex there.
 * Snapshot ids are stored on the signed-in user, not a shared `.ytimesy/` file.
 */
export function connectCodexWorkspaceSession(
	machines: WorkspaceMachines,
	scope: CodexSessionScope,
): Effect.Effect<PublicCodexSession> {
	return Effect.gen(function* () {
		const snapshotId = yield* Effect.tryPromise(() =>
			loadAgentSnapshotId(scope.userId),
		);
		const workspace = yield* Effect.tryPromise(() =>
			readyWorkspaceForOwner(scope.userId, scope.projectId),
		);
		const blocked = codexConnectBlockedReason(workspace);
		if (blocked || !workspace?.providerRef) {
			return {
				...emptyCodexSession(Boolean(snapshotId)),
				connection: {
					status: "failed" as const,
					provider: "codex" as const,
					message: blocked ?? "Prepare a workspace before signing in to Codex.",
				},
			};
		}

		yield* Effect.tryPromise(() =>
			machines.ensureRunning(WorkspaceId(workspace.providerRef as string)),
		);

		const existing = yield* readCodexWorkspaceSession(machines, scope);
		if (existing.connection.status === "authenticated") {
			return existing;
		}
		if (existing.connection.status === "awaiting_device_code") {
			return existing;
		}

		const status = yield* authenticatePreparedWorkspace(
			machines,
			WorkspaceId(workspace.providerRef),
			Boolean(snapshotId),
		);
		if (status.stage === "authenticated") {
			yield* persistCodexAuthSnapshotForUser(
				scope.userId,
				machines,
				WorkspaceId(workspace.providerRef),
				{ planType: status.planType, email: null },
			);
		}
		return viewFromStatus(
			status,
			workspace.providerRef,
			Boolean(snapshotId) || status.stage === "authenticated",
		);
	}).pipe(
		Effect.catchAll((cause) =>
			Effect.succeed({
				...emptyCodexSession(),
				connection: {
					status: "failed" as const,
					provider: "codex" as const,
					message: cause instanceof Error ? cause.message : String(cause),
				},
			}),
		),
	);
}

export function sendCodexWorkspaceTask(
	machines: WorkspaceMachines,
	scope: CodexSessionScope,
	input: {
		readonly text: string;
		readonly modelId: string;
		readonly lane?: "main" | "side";
	},
): Effect.Effect<PublicCodexSession> {
	return withPreparedWorkspace(
		machines,
		scope,
		(providerRef, snapshotAvailable) =>
			submitCodexTask(machines, WorkspaceId(providerRef), input).pipe(
				Effect.map((status) =>
					viewFromStatus(status, providerRef, snapshotAvailable),
				),
			),
	);
}

export function stopCodexWorkspaceTurn(
	machines: WorkspaceMachines,
	scope: CodexSessionScope,
): Effect.Effect<PublicCodexSession> {
	return withPreparedWorkspace(
		machines,
		scope,
		(providerRef, snapshotAvailable) =>
			interruptCodexTurn(machines, WorkspaceId(providerRef)).pipe(
				Effect.map((status) =>
					viewFromStatus(status, providerRef, snapshotAvailable),
				),
			),
	);
}

function withPreparedWorkspace<A>(
	machines: WorkspaceMachines,
	scope: CodexSessionScope,
	run: (providerRef: string, snapshotAvailable: boolean) => Effect.Effect<A>,
): Effect.Effect<A | PublicCodexSession> {
	return Effect.gen(function* () {
		const snapshotId = yield* Effect.tryPromise(() =>
			loadAgentSnapshotId(scope.userId),
		);
		const workspace = yield* Effect.tryPromise(() =>
			readyWorkspaceForOwner(scope.userId, scope.projectId),
		);
		const providerRef = workspaceSessionMachineRef(workspace);
		if (!providerRef) {
			return emptyCodexSession(Boolean(snapshotId));
		}
		yield* Effect.tryPromise(() =>
			machines.ensureRunning(WorkspaceId(providerRef)),
		);
		return yield* run(providerRef, Boolean(snapshotId));
	}).pipe(
		Effect.catchAll((cause) =>
			Effect.succeed({
				...emptyCodexSession(),
				connection: {
					status: "failed" as const,
					provider: "codex" as const,
					message: cause instanceof Error ? cause.message : String(cause),
				},
			}),
		),
	);
}

function authenticatePreparedWorkspace(
	machines: WorkspaceMachines,
	workspaceId: WorkspaceId,
	snapshotAvailable: boolean,
): Effect.Effect<CodexLoginStatus> {
	return Effect.gen(function* () {
		const status = snapshotAvailable
			? yield* resumeCodexSession(machines, workspaceId, {
					skipInitialTurn: true,
				})
			: yield* startInteractiveDeviceCodeLogin(machines, workspaceId, {
					skipInitialTurn: true,
				});
		if (snapshotAvailable && status.stage === "failed") {
			return yield* startInteractiveDeviceCodeLogin(machines, workspaceId, {
				skipInitialTurn: true,
			});
		}
		return status;
	});
}

function viewFromStatus(
	status: CodexLoginStatus,
	workspaceId: string,
	snapshotAvailable: boolean,
): PublicCodexSession {
	const connection = connectionFromStatus(status);
	const workspace: WorkspaceLifecycle = {
		status: "running",
		workspaceId: WorkspaceId(workspaceId),
	};
	const models = status.stage === "authenticated" ? status.models : [];
	const turnStatus =
		status.stage === "authenticated" ? status.turnStatus : "idle";
	const items = status.stage === "authenticated" ? status.items : [];
	const sideTurnStatus =
		status.stage === "authenticated" ? status.sideTurnStatus : "idle";
	const sideItems = status.stage === "authenticated" ? status.sideItems : [];
	return {
		snapshotAvailable,
		workspaceId,
		connection,
		models,
		canSend: canSubmitComposer(workspace, connection, turnStatus),
		canSendSide: canSubmitSideChat(workspace, connection, sideTurnStatus),
		turnStatus,
		items,
		sideTurnStatus,
		sideItems,
	};
}

function connectionFromStatus(status: CodexLoginStatus): AgentConnection {
	if (status.stage === "authenticated") {
		return {
			status: "authenticated",
			provider: "codex",
			authMode: "chatgpt",
			planType: status.planType,
			email: null,
		};
	}
	if (status.stage === "awaiting_device_code") {
		return {
			status: "awaiting_device_code",
			provider: "codex",
			loginId: status.loginId,
			verificationUrl: status.verificationUrl,
			userCode: status.userCode,
		};
	}
	if (status.stage === "failed") {
		return {
			status: "failed",
			provider: "codex",
			message: status.message,
		};
	}
	return disconnected;
}
