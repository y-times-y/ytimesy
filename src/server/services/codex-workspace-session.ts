import { Effect } from "effect";
import type { AgentConnection } from "#/domain/agent-connection";
import { WorkspaceId } from "#/domain/ids";
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
import { PROOF_LOGIN_LIFETIME } from "#/server/adapters/freestyle/proof-vm";
import {
	readAuthSnapshotState,
	readProofVmState,
	writeProofVmState,
} from "#/server/proof/codex-login-state";
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
 * Reads the current proof workspace without provisioning. Missing or dead VMs
 * become a disconnected session so the homepage can render.
 */
export function readCodexWorkspaceSession(
	machines: WorkspaceMachines,
): Effect.Effect<PublicCodexSession> {
	return Effect.gen(function* () {
		const snapshot = yield* Effect.tryPromise(() => readAuthSnapshotState());
		const vm = yield* Effect.tryPromise(() => readProofVmState());
		if (!vm) {
			return emptyCodexSession(Boolean(snapshot));
		}
		const status = yield* readLoginStatus(
			machines,
			WorkspaceId(vm.workspaceId),
		);
		return viewFromStatus(status, vm.workspaceId, Boolean(snapshot));
	}).pipe(
		Effect.catchAll(() =>
			Effect.tryPromise(() => readAuthSnapshotState()).pipe(
				Effect.map((snapshot) => emptyCodexSession(Boolean(snapshot))),
				Effect.catchAll(() => Effect.succeed(emptyCodexSession())),
			),
		),
	);
}

/**
 * Boots from the private ChatGPT snapshot when one exists, otherwise starts
 * device-code login. Reuses the existing app-server daemon; does not add ACP.
 */
export function connectCodexWorkspaceSession(
	machines: WorkspaceMachines,
): Effect.Effect<PublicCodexSession> {
	return Effect.gen(function* () {
		const existing = yield* readCodexWorkspaceSession(machines);
		if (existing.connection.status === "authenticated") {
			return existing;
		}
		if (existing.connection.status === "awaiting_device_code") {
			return existing;
		}

		const snapshot = yield* Effect.tryPromise(() => readAuthSnapshotState());
		const workspace = snapshot
			? yield* Effect.tryPromise(() =>
					machines.createProofWorkspace({
						...PROOF_LOGIN_LIFETIME,
						snapshotId: snapshot.snapshotId,
					}),
				)
			: yield* Effect.tryPromise(() =>
					machines.createProofWorkspace(PROOF_LOGIN_LIFETIME),
				);

		yield* Effect.tryPromise(() =>
			writeProofVmState({
				workspaceId: workspace.workspaceId,
				slug: workspace.slug,
				startedAt: new Date().toISOString(),
				bootedFromSnapshotId: snapshot?.snapshotId ?? null,
			}),
		);

		const status = snapshot
			? yield* resumeCodexSession(machines, workspace.workspaceId, {
					skipInitialTurn: true,
				})
			: yield* startInteractiveDeviceCodeLogin(
					machines,
					workspace.workspaceId,
					{ skipInitialTurn: true },
				);

		if (snapshot && status.stage === "failed") {
			const retry = yield* startInteractiveDeviceCodeLogin(
				machines,
				workspace.workspaceId,
				{ skipInitialTurn: true },
			);
			return viewFromStatus(retry, workspace.workspaceId, Boolean(snapshot));
		}

		return viewFromStatus(status, workspace.workspaceId, Boolean(snapshot));
	}).pipe(
		Effect.catchAll((cause) =>
			Effect.succeed({
				...emptyCodexSession(),
				connection: {
					status: "failed" as const,
					message: cause instanceof Error ? cause.message : String(cause),
				},
			}),
		),
	);
}

export function sendCodexWorkspaceTask(
	machines: WorkspaceMachines,
	input: {
		readonly text: string;
		readonly modelId: string;
		readonly lane?: "main" | "side";
	},
): Effect.Effect<PublicCodexSession> {
	return Effect.gen(function* () {
		const vm = yield* Effect.tryPromise(() => readProofVmState());
		if (!vm) {
			return emptyCodexSession();
		}
		const snapshot = yield* Effect.tryPromise(() => readAuthSnapshotState());
		const status = yield* submitCodexTask(
			machines,
			WorkspaceId(vm.workspaceId),
			input,
		);
		return viewFromStatus(status, vm.workspaceId, Boolean(snapshot));
	}).pipe(
		Effect.catchAll((cause) =>
			Effect.succeed({
				...emptyCodexSession(),
				connection: {
					status: "failed" as const,
					message: cause instanceof Error ? cause.message : String(cause),
				},
			}),
		),
	);
}

export function stopCodexWorkspaceTurn(
	machines: WorkspaceMachines,
): Effect.Effect<PublicCodexSession> {
	return Effect.gen(function* () {
		const vm = yield* Effect.tryPromise(() => readProofVmState());
		if (!vm) {
			return emptyCodexSession();
		}
		const snapshot = yield* Effect.tryPromise(() => readAuthSnapshotState());
		const status = yield* interruptCodexTurn(
			machines,
			WorkspaceId(vm.workspaceId),
		);
		return viewFromStatus(status, vm.workspaceId, Boolean(snapshot));
	}).pipe(
		Effect.catchAll((cause) =>
			Effect.succeed({
				...emptyCodexSession(),
				connection: {
					status: "failed" as const,
					message: cause instanceof Error ? cause.message : String(cause),
				},
			}),
		),
	);
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
			authMode: "chatgpt",
			planType: status.planType,
			email: null,
		};
	}
	if (status.stage === "awaiting_device_code") {
		return {
			status: "awaiting_device_code",
			loginId: status.loginId,
			verificationUrl: status.verificationUrl,
			userCode: status.userCode,
		};
	}
	if (status.stage === "failed") {
		return { status: "failed", message: status.message };
	}
	return disconnected;
}
