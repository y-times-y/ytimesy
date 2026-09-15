import { Effect } from "effect";
import type { AgentConnection } from "#/domain/agent-connection";
import { canResumeDisconnectedFollowUp } from "#/domain/harness-access";
import { WorkspaceId } from "#/domain/ids";
import {
	listedModelPreferenceFromSessions,
	submittedListedModelId,
} from "#/domain/listed-model";
import {
	codexConnectBlockedReason,
	publicFailureMessage,
} from "#/domain/project-workspace";
import { shouldStartDeviceCodeAfterSnapshotResume } from "#/domain/proof-workspace-recovery";
import type { SessionItem, SessionTurnStatus } from "#/domain/session-item";
import { canSubmitComposer, canSubmitSideChat } from "#/domain/session-policy";
import type { WorkspaceLifecycle } from "#/domain/workspace";
import type { AgentSessionRecord } from "#/server/adapters/agent-sessions";
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
import { readyWorkspaceForOwner } from "#/server/adapters/workspaces";
import { loadAgentSnapshotId } from "#/server/auth/agent-account";
import { persistCodexAuthSnapshotForUser } from "#/server/proof/persist-codex-auth-snapshot";
import {
	bindAgentSessionMachine,
	peekAgentSessionMachine,
	syncProjectContextForTask,
} from "./agent-session-machine";
import {
	persistBoundSessionView,
	persistSessionTurnStatus,
} from "./persist-session-view";
import { preparePreparedGuest } from "./project-workspace";
import type { WorkspaceMachines } from "./workspace-machines";

export type PublicCodexSession = {
	readonly snapshotAvailable: boolean;
	readonly workspaceId: string | null;
	readonly agentSessionId: string | null;
	readonly connection: AgentConnection;
	readonly models: readonly ListedModel[];
	readonly listedModelId: string;
	readonly blockedListedModelIds: readonly string[];
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
	readonly sessionId?: string;
	readonly createNew?: boolean;
};

const disconnected: AgentConnection = { status: "disconnected" };

export function emptyCodexSession(
	snapshotAvailable = false,
): PublicCodexSession {
	return {
		snapshotAvailable,
		workspaceId: null,
		agentSessionId: null,
		connection: disconnected,
		models: [],
		listedModelId: "",
		blockedListedModelIds: [],
		canSend: false,
		canSendSide: false,
		turnStatus: "idle",
		items: [],
		sideTurnStatus: "idle",
		sideItems: [],
	};
}

function pausedCodexSessionView(
	workspaceId: string,
	snapshotAvailable: boolean,
): PublicCodexSession {
	const view = emptyCodexSession(snapshotAvailable);
	return {
		...view,
		workspaceId,
		canSendSide: canResumeDisconnectedFollowUp({
			harnessId: "codex",
			connection: view.connection,
			turnStatus: "idle",
			snapshotAvailable,
		}),
	};
}

/**
 * Reads Codex on this agent session. Paused VMs stay paused; the stored
 * transcript is enough to render the chat until Connect wakes the machine.
 */
export function readCodexWorkspaceSession(
	machines: WorkspaceMachines,
	scope: CodexSessionScope,
): Effect.Effect<PublicCodexSession> {
	return Effect.gen(function* () {
		const snapshotId = yield* Effect.tryPromise(() =>
			loadAgentSnapshotId(scope.userId),
		);
		if (!scope.projectId) return emptyCodexSession(Boolean(snapshotId));
		const peeked = yield* Effect.tryPromise(() =>
			peekAgentSessionMachine({
				userId: scope.userId,
				projectId: scope.projectId as string,
				sessionId: scope.sessionId,
			}),
		);
		const providerRef = peeked.providerRef;
		if (!providerRef) {
			return yield* Effect.tryPromise(() =>
				persistBoundSessionView(
					peeked.session,
					emptyCodexSession(Boolean(snapshotId)),
				),
			);
		}
		const running = yield* Effect.tryPromise(() =>
			machines.isRunning(WorkspaceId(providerRef)),
		);
		if (!running) {
			return yield* Effect.tryPromise(() =>
				persistBoundSessionView(
					peeked.session,
					pausedCodexSessionView(providerRef, Boolean(snapshotId)),
				),
			);
		}
		const status = yield* readLoginStatus(machines, WorkspaceId(providerRef));
		return yield* Effect.tryPromise(() =>
			persistBoundSessionView(
				peeked.session,
				viewFromStatus(status, providerRef, Boolean(snapshotId)),
			),
		);
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

		const bound = yield* Effect.tryPromise(() =>
			bindAgentSessionMachine(machines, {
				userId: scope.userId,
				projectId: scope.projectId as string,
				harness: "codex",
				sessionId: scope.sessionId,
				createNew: scope.createNew,
			}),
		);
		yield* Effect.tryPromise(() =>
			machines.ensureRunning(WorkspaceId(bound.providerRef)),
		);

		const existing = yield* readCodexWorkspaceSession(machines, {
			...scope,
			sessionId: bound.session.id,
			createNew: false,
		});
		if (existing.connection.status === "authenticated") {
			yield* prepareCodexGuest(machines, WorkspaceId(bound.providerRef), scope);
			return yield* readCodexWorkspaceSession(machines, {
				...scope,
				sessionId: bound.session.id,
				createNew: false,
			});
		}
		if (existing.connection.status === "awaiting_device_code") {
			return existing;
		}

		const status = yield* authenticatePreparedWorkspace(
			machines,
			WorkspaceId(bound.providerRef),
			Boolean(snapshotId),
		);
		if (status.stage === "authenticated") {
			yield* persistCodexAuthSnapshotForUser(
				scope.userId,
				machines,
				WorkspaceId(bound.providerRef),
				{ planType: status.planType, email: null },
			);
			yield* prepareCodexGuest(machines, WorkspaceId(bound.providerRef), scope);
		}
		return yield* Effect.tryPromise(() =>
			persistBoundSessionView(
				bound.session,
				viewFromStatus(
					status,
					bound.providerRef,
					Boolean(snapshotId) || status.stage === "authenticated",
				),
			),
		);
	}).pipe(
		Effect.catchAll((cause) =>
			Effect.succeed({
				...emptyCodexSession(),
				connection: {
					status: "failed" as const,
					provider: "codex" as const,
					message: publicFailureMessage(cause),
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
	},
): Effect.Effect<PublicCodexSession> {
	return withPreparedWorkspace(
		machines,
		scope,
		(providerRef, snapshotAvailable, session) =>
			Effect.gen(function* () {
				yield* prepareCodexGuest(machines, WorkspaceId(providerRef), scope);
				let status = yield* readLoginStatus(machines, WorkspaceId(providerRef));
				if (status.stage !== "authenticated") {
					status = yield* authenticatePreparedWorkspace(
						machines,
						WorkspaceId(providerRef),
						snapshotAvailable,
					);
				}
				if (status.stage !== "authenticated") {
					return viewFromStatus(status, providerRef, snapshotAvailable);
				}
				const preference = listedModelPreferenceFromSessions({
					harness: session.harness,
					sessions: [session],
				});
				const modelId = submittedListedModelId(input.modelId, status.models, {
					lastUsedId: preference.listedModelId,
					excludedIds: preference.blockedListedModelIds,
				});
				if (!modelId) {
					return viewFromStatus(status, providerRef, snapshotAvailable);
				}
				if (scope.projectId) {
					yield* Effect.tryPromise(() =>
						syncProjectContextForTask(machines, providerRef, {
							projectId: scope.projectId as string,
							task: input.text,
						}),
					);
				}
				yield* Effect.tryPromise(() =>
					persistSessionTurnStatus(session, "running"),
				);
				status = yield* submitCodexTask(machines, WorkspaceId(providerRef), {
					text: input.text,
					modelId,
				});
				return {
					...viewFromStatus(status, providerRef, snapshotAvailable),
					listedModelId: modelId,
				};
			}),
	);
}

/**
 * Interrupt talks to a live Codex daemon. A paused VM is already stopped;
 * persist idle without booting so Stop does not consume compute allowance.
 */
export function stopCodexWorkspaceTurn(
	machines: WorkspaceMachines,
	scope: CodexSessionScope,
): Effect.Effect<PublicCodexSession> {
	return Effect.gen(function* () {
		const snapshotId = yield* Effect.tryPromise(() =>
			loadAgentSnapshotId(scope.userId),
		);
		if (!scope.projectId) return emptyCodexSession(Boolean(snapshotId));
		const peeked = yield* Effect.tryPromise(() =>
			peekAgentSessionMachine({
				userId: scope.userId,
				projectId: scope.projectId as string,
				sessionId: scope.sessionId,
			}),
		);
		const providerRef = peeked.providerRef;
		if (!providerRef) {
			yield* Effect.tryPromise(() =>
				persistSessionTurnStatus(peeked.session, "idle"),
			);
			return yield* Effect.tryPromise(() =>
				persistBoundSessionView(
					peeked.session,
					emptyCodexSession(Boolean(snapshotId)),
				),
			);
		}
		const running = yield* Effect.tryPromise(() =>
			machines.isRunning(WorkspaceId(providerRef)),
		);
		if (!running) {
			yield* Effect.tryPromise(() =>
				persistSessionTurnStatus(peeked.session, "idle"),
			);
			const paused = yield* Effect.tryPromise(() =>
				persistBoundSessionView(
					peeked.session,
					pausedCodexSessionView(providerRef, Boolean(snapshotId)),
				),
			);
			return { ...paused, turnStatus: "idle" as const };
		}
		const status = yield* interruptCodexTurn(
			machines,
			WorkspaceId(providerRef),
		);
		return yield* Effect.tryPromise(() =>
			persistBoundSessionView(
				peeked.session,
				viewFromStatus(status, providerRef, Boolean(snapshotId)),
			),
		);
	}).pipe(
		Effect.catchAll((cause) =>
			Effect.succeed({
				...emptyCodexSession(),
				connection: {
					status: "failed" as const,
					provider: "codex" as const,
					message: publicFailureMessage(cause),
				},
			}),
		),
	);
}

function withPreparedWorkspace<A>(
	machines: WorkspaceMachines,
	scope: CodexSessionScope,
	run: (
		providerRef: string,
		snapshotAvailable: boolean,
		session: AgentSessionRecord,
	) => Effect.Effect<A, Error>,
): Effect.Effect<A | PublicCodexSession> {
	return Effect.gen(function* () {
		const snapshotId = yield* Effect.tryPromise(() =>
			loadAgentSnapshotId(scope.userId),
		);
		if (!scope.projectId) return emptyCodexSession(Boolean(snapshotId));
		const bound = yield* Effect.tryPromise(() =>
			bindAgentSessionMachine(machines, {
				userId: scope.userId,
				projectId: scope.projectId as string,
				harness: "codex",
				sessionId: scope.sessionId,
				createNew: scope.createNew,
			}),
		);
		yield* Effect.tryPromise(() =>
			machines.ensureRunning(WorkspaceId(bound.providerRef)),
		);
		const result = yield* run(
			bound.providerRef,
			Boolean(snapshotId),
			bound.session,
		);
		if (isPublicCodexSession(result)) {
			return yield* Effect.tryPromise(() =>
				persistBoundSessionView(bound.session, result),
			);
		}
		return result;
	}).pipe(
		Effect.catchAll((cause) =>
			Effect.succeed({
				...emptyCodexSession(),
				connection: {
					status: "failed" as const,
					provider: "codex" as const,
					message: publicFailureMessage(cause),
				},
			}),
		),
	);
}

function isPublicCodexSession(value: unknown): value is PublicCodexSession {
	return Boolean(
		value &&
			typeof value === "object" &&
			"connection" in value &&
			"items" in value,
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
		if (snapshotAvailable && shouldStartDeviceCodeAfterSnapshotResume(status)) {
			return yield* startInteractiveDeviceCodeLogin(machines, workspaceId, {
				skipInitialTurn: true,
			});
		}
		return status;
	});
}

function prepareCodexGuest(
	machines: WorkspaceMachines,
	workspaceId: WorkspaceId,
	scope: CodexSessionScope,
): Effect.Effect<void, Error> {
	return Effect.gen(function* () {
		yield* preparePreparedGuest(machines, workspaceId, scope);
		yield* ensureCurrentLoginDaemon(machines, workspaceId).pipe(
			Effect.catchAll(() => Effect.void),
		);
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
	return {
		snapshotAvailable,
		workspaceId,
		agentSessionId: null,
		connection,
		models,
		listedModelId: "",
		blockedListedModelIds: [],
		canSend: canSubmitComposer(workspace, connection, turnStatus),
		canSendSide: canSubmitSideChat(workspace, connection, "idle"),
		turnStatus,
		items,
		sideTurnStatus: "idle",
		sideItems: [],
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
