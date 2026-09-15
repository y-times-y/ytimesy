import { Effect } from "effect";
import type { AgentConnection } from "#/domain/agent-connection";
import { failureMessage, workspaceLooksGone } from "#/domain/failure-message";
import { WorkspaceId } from "#/domain/ids";
import {
	loginStatusLooksLikeGoneWorkspace,
	shouldStartDeviceCodeAfterSnapshotResume,
} from "#/domain/proof-workspace-recovery";
import type { SessionItem, SessionTurnStatus } from "#/domain/session-item";
import { canSubmitComposer, canSubmitSideChat } from "#/domain/session-policy";
import type { WorkspaceLifecycle } from "#/domain/workspace";
import {
	ensureCurrentLoginDaemon,
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
	deleteProofVmState,
	readAuthSnapshotState,
	readProofVmState,
	writeProofVmState,
} from "#/server/proof/codex-login-state";
import { ensureProjectCheckout } from "./project-workspace";
import { startWorkspaceDesktop } from "./workspace-desktop";
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
		if (loginStatusLooksLikeGoneWorkspace(status)) {
			yield* discardProofWorkspace(machines, vm.workspaceId);
			return emptyCodexSession(Boolean(snapshot));
		}
		return viewFromStatus(status, vm.workspaceId, Boolean(snapshot));
	}).pipe(Effect.catchAll((cause) => sessionAfterFailure(cause)));
}

/**
 * Boots from the private ChatGPT snapshot when one exists, otherwise starts
 * device-code login. Reuses a live proof VM and its app-server daemon when
 * present; does not add ACP.
 */
export function connectCodexWorkspaceSession(
	machines: WorkspaceMachines,
): Effect.Effect<PublicCodexSession> {
	return Effect.gen(function* () {
		const snapshot = yield* Effect.tryPromise(() => readAuthSnapshotState());
		const snapshotAvailable = Boolean(snapshot);
		const existing = yield* readCodexWorkspaceSession(machines);
		if (existing.connection.status === "authenticated") {
			yield* prepareAgentGuest(machines, existing.workspaceId);
			return yield* readCodexWorkspaceSession(machines);
		}
		if (existing.connection.status === "awaiting_device_code") {
			return existing;
		}

		const existingVm = yield* Effect.tryPromise(() => readProofVmState());
		if (existingVm) {
			const resumed = yield* authenticateProofWorkspace(
				machines,
				WorkspaceId(existingVm.workspaceId),
				snapshotAvailable,
			);
			if (
				resumed.stage === "authenticated" ||
				resumed.stage === "awaiting_device_code"
			) {
				if (resumed.stage === "authenticated") {
					yield* prepareAgentGuest(machines, existingVm.workspaceId);
				}
				return viewFromStatus(
					resumed,
					existingVm.workspaceId,
					snapshotAvailable,
				);
			}
			if (loginStatusLooksLikeGoneWorkspace(resumed)) {
				yield* discardProofWorkspace(machines, existingVm.workspaceId);
			} else {
				return viewFromStatus(
					resumed,
					existingVm.workspaceId,
					snapshotAvailable,
				);
			}
		}

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

		const status = yield* authenticateProofWorkspace(
			machines,
			workspace.workspaceId,
			snapshotAvailable,
		);
		if (status.stage === "authenticated") {
			yield* prepareAgentGuest(machines, workspace.workspaceId);
		}
		return viewFromStatus(status, workspace.workspaceId, snapshotAvailable);
	}).pipe(Effect.catchAll((cause) => sessionAfterFailure(cause)));
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
		const snapshot = yield* Effect.tryPromise(() => readAuthSnapshotState());
		if (!vm) {
			return emptyCodexSession(Boolean(snapshot));
		}
		yield* ensureProjectCheckout(machines, WorkspaceId(vm.workspaceId));
		yield* ensureCurrentLoginDaemon(machines, WorkspaceId(vm.workspaceId));
		const status = yield* submitCodexTask(
			machines,
			WorkspaceId(vm.workspaceId),
			input,
		);
		if (loginStatusLooksLikeGoneWorkspace(status)) {
			yield* discardProofWorkspace(machines, vm.workspaceId);
			return emptyCodexSession(Boolean(snapshot));
		}
		return viewFromStatus(status, vm.workspaceId, Boolean(snapshot));
	}).pipe(Effect.catchAll((cause) => sessionAfterFailure(cause)));
}

export function stopCodexWorkspaceTurn(
	machines: WorkspaceMachines,
): Effect.Effect<PublicCodexSession> {
	return Effect.gen(function* () {
		const vm = yield* Effect.tryPromise(() => readProofVmState());
		const snapshot = yield* Effect.tryPromise(() => readAuthSnapshotState());
		if (!vm) {
			return emptyCodexSession(Boolean(snapshot));
		}
		const status = yield* interruptCodexTurn(
			machines,
			WorkspaceId(vm.workspaceId),
		);
		if (loginStatusLooksLikeGoneWorkspace(status)) {
			yield* discardProofWorkspace(machines, vm.workspaceId);
			return emptyCodexSession(Boolean(snapshot));
		}
		return viewFromStatus(status, vm.workspaceId, Boolean(snapshot));
	}).pipe(Effect.catchAll((cause) => sessionAfterFailure(cause)));
}

/**
 * Resumes ChatGPT auth on an existing proof VM. Snapshot boots skip device
 * code unless resume fails on a VM that is still there. A missing VM is
 * discarded by the caller so a new copy can boot from the saved snapshot.
 */
function authenticateProofWorkspace(
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
		if (snapshotAvailable && shouldStartDeviceCodeAfterSnapshotResume(status)) {
			return yield* startInteractiveDeviceCodeLogin(machines, workspaceId, {
				skipInitialTurn: true,
			});
		}
		return status;
	});
}

function prepareAgentGuest(
	machines: WorkspaceMachines,
	workspaceId: string | null,
): Effect.Effect<void> {
	if (!workspaceId) return Effect.void;
	return Effect.gen(function* () {
		yield* ensureProjectCheckout(machines, WorkspaceId(workspaceId));
		yield* ensureCurrentLoginDaemon(machines, WorkspaceId(workspaceId));
		yield* Effect.sync(() => {
			void Effect.runPromise(startWorkspaceDesktop(machines));
		});
	}).pipe(Effect.catchAll(() => Effect.void));
}

function discardProofWorkspace(
	machines: WorkspaceMachines,
	workspaceId: string,
): Effect.Effect<void> {
	return Effect.tryPromise(async () => {
		await machines.destroy(WorkspaceId(workspaceId)).catch(() => undefined);
		await deleteProofVmState();
	}).pipe(Effect.catchAll(() => Effect.void));
}

function sessionAfterFailure(
	cause: unknown,
): Effect.Effect<PublicCodexSession> {
	const message = failureMessage(cause);
	return Effect.gen(function* () {
		if (workspaceLooksGone(message)) {
			yield* Effect.tryPromise(() => deleteProofVmState()).pipe(
				Effect.catchAll(() => Effect.void),
			);
		}
		const snapshot = yield* Effect.tryPromise(() =>
			readAuthSnapshotState(),
		).pipe(Effect.catchAll(() => Effect.succeed(null)));
		if (workspaceLooksGone(message)) {
			return emptyCodexSession(Boolean(snapshot));
		}
		return {
			...emptyCodexSession(Boolean(snapshot)),
			connection: {
				status: "failed" as const,
				provider: "codex" as const,
				message,
			},
		};
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
