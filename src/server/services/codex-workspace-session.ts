import { Effect } from "effect";
import type { AgentConnection } from "#/domain/agent-connection";
import type { CodexUsage } from "#/domain/codex-usage";
import { canResumeDisconnectedFollowUp } from "#/domain/harness-access";
import { WorkspaceId } from "#/domain/ids";
import {
	listedFastModeId,
	listedModelPreferenceFromSessions,
	submittedListedModelId,
} from "#/domain/listed-model";
import {
	codexConnectBlockedReason,
	publicFailureMessage,
} from "#/domain/project-workspace";
import type { SessionItem, SessionTurnStatus } from "#/domain/session-item";
import { canSubmitComposer, canSubmitSideChat } from "#/domain/session-policy";
import type { WorkspaceLifecycle } from "#/domain/workspace";
import type { AgentSessionRecord } from "#/server/adapters/agent-sessions";
import {
	CODEX_REFRESH_REQUEST_PATH,
	CODEX_REFRESH_RESPONSE_PATH,
	configureCodexExternalAuth,
	ensureCurrentLoginDaemon,
	interruptCodexTurn,
	readLoginStatus,
	startInteractiveDeviceCodeLogin,
	submitCodexTask,
} from "#/server/adapters/codex/login-session";
import type {
	CodexLoginStatus,
	ListedModel,
} from "#/server/adapters/codex/login-status";
import { readyWorkspaceForOwner } from "#/server/adapters/workspaces";
import {
	captureManagedCodexAuth,
	codexExternalTokens,
	hasManagedCodexAuth,
} from "#/server/auth/codex-managed-auth";
import {
	bindAgentSessionMachine,
	peekAgentSessionMachine,
	syncProjectContextForTask,
} from "./agent-session-machine";
import { codexRuntimeForSession } from "./codex-runtime";
import {
	persistBoundSessionView,
	persistSessionTurnStatus,
} from "./persist-session-view";
import { preparePreparedGuest } from "./project-workspace";
import { beginSharedDesktop } from "./workspace-desktop";
import type { WorkspaceMachines } from "./workspace-machines";

export type PublicCodexSession = {
	readonly usage?: CodexUsage;
	readonly snapshotAvailable: boolean;
	readonly workspaceId: string | null;
	readonly agentSessionId: string | null;
	readonly selectedBranch?: string | null;
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
		const hasCodexAuth = yield* Effect.tryPromise(() =>
			hasManagedCodexAuth(scope.userId),
		);
		if (!scope.projectId) return emptyCodexSession(hasCodexAuth);
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
					emptyCodexSession(hasCodexAuth),
				),
			);
		}
		const savedSession = peeked.session;
		const runtime = savedSession
			? yield* Effect.tryPromise(() =>
					codexRuntimeForSession(machines, { ...savedSession, providerRef }),
				)
			: { machines, workspaceId: WorkspaceId(providerRef) };
		const running = yield* Effect.tryPromise(() =>
			runtime.machines.isRunning(runtime.workspaceId),
		);
		if (!running) {
			return yield* Effect.tryPromise(() =>
				persistBoundSessionView(
					peeked.session,
					pausedCodexSessionView(providerRef, hasCodexAuth),
				),
			);
		}
		let status = yield* readLoginStatus(runtime.machines, runtime.workspaceId);
		if (status.stage === "authenticated") {
			status = yield* promoteCodexLogin(
				runtime.machines,
				runtime.workspaceId,
				scope.userId,
				status,
			);
			yield* Effect.tryPromise(() =>
				serviceCodexRefreshRequest(
					runtime.machines,
					runtime.workspaceId,
					scope.userId,
				),
			);
		}
		return yield* Effect.tryPromise(() =>
			persistBoundSessionView(
				peeked.session,
				viewFromStatus(status, providerRef, hasCodexAuth),
			),
		);
	}).pipe(
		Effect.catchAll(() =>
			Effect.tryPromise(() => hasManagedCodexAuth(scope.userId)).pipe(
				Effect.map((hasCodexAuth) => emptyCodexSession(hasCodexAuth)),
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
		const hasCodexAuth = yield* Effect.tryPromise(() =>
			hasManagedCodexAuth(scope.userId),
		);
		const workspace = yield* Effect.tryPromise(() =>
			readyWorkspaceForOwner(scope.userId, scope.projectId),
		);
		const blocked = codexConnectBlockedReason(workspace);
		if (blocked) {
			return {
				...emptyCodexSession(hasCodexAuth),
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
		yield* prepareCodexGuest(machines, WorkspaceId(bound.providerRef), {
			...scope,
			sessionId: bound.session.id,
		});
		const runtime = yield* Effect.tryPromise(() =>
			codexRuntimeForSession(
				machines,
				{ ...bound.session, providerRef: bound.providerRef },
				true,
			),
		);

		const existing = yield* readCodexWorkspaceSession(machines, {
			...scope,
			sessionId: bound.session.id,
			createNew: false,
		});
		if (existing.connection.status === "authenticated" && hasCodexAuth) {
			yield* ensureCurrentLoginDaemon(runtime.machines, runtime.workspaceId);
			return yield* readCodexWorkspaceSession(machines, {
				...scope,
				sessionId: bound.session.id,
				createNew: false,
			});
		}
		if (existing.connection.status === "awaiting_device_code") {
			return existing;
		}

		let status = yield* authenticatePreparedWorkspace(
			runtime.machines,
			runtime.workspaceId,
			scope.userId,
		);
		if (status.stage === "authenticated") {
			status = yield* promoteCodexLogin(
				runtime.machines,
				runtime.workspaceId,
				scope.userId,
				status,
			);
			yield* ensureCurrentLoginDaemon(runtime.machines, runtime.workspaceId);
		}
		return yield* Effect.tryPromise(() =>
			persistBoundSessionView(
				bound.session,
				viewFromStatus(
					status,
					bound.providerRef,
					hasCodexAuth || status.stage === "authenticated",
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
		readonly variant?: string;
		readonly fast?: boolean;
	},
): Effect.Effect<PublicCodexSession> {
	return withPreparedWorkspace(
		machines,
		scope,
		(providerRef, snapshotAvailable, session) =>
			Effect.gen(function* () {
				yield* prepareCodexGuest(machines, WorkspaceId(providerRef), {
					...scope,
					sessionId: session.id,
				});
				if (scope.projectId && !session.parentSessionId) {
					yield* Effect.tryPromise(() =>
						syncProjectContextForTask(machines, providerRef, {
							projectId: scope.projectId as string,
							task: input.text,
						}),
					);
				}
				const runtime = yield* Effect.tryPromise(() =>
					codexRuntimeForSession(machines, { ...session, providerRef }, true),
				);
				let status = yield* readLoginStatus(
					runtime.machines,
					runtime.workspaceId,
				);
				const managed = yield* Effect.tryPromise(() =>
					hasManagedCodexAuth(scope.userId),
				);
				if (status.stage !== "authenticated" || managed) {
					status = yield* authenticatePreparedWorkspace(
						runtime.machines,
						runtime.workspaceId,
						scope.userId,
					);
				}
				if (status.stage !== "authenticated") {
					return viewFromStatus(status, providerRef, snapshotAvailable);
				}
				status = yield* promoteCodexLogin(
					runtime.machines,
					runtime.workspaceId,
					scope.userId,
					status,
				);
				if (status.stage !== "authenticated") {
					return viewFromStatus(status, providerRef, snapshotAvailable);
				}
				yield* ensureCurrentLoginDaemon(runtime.machines, runtime.workspaceId);
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
				yield* Effect.tryPromise(() =>
					persistSessionTurnStatus(session, "running"),
				);
				const listed = status.models.find((model) => model.id === modelId);
				const reasoningEffort =
					input.variant?.trim() &&
					listed?.reasoning?.levels.some(
						(level) => level.id === input.variant?.trim(),
					)
						? input.variant.trim()
						: undefined;
				const serviceTier = input.fast
					? listedFastModeId(listed ?? {})
					: undefined;
				status = yield* submitCodexTask(runtime.machines, runtime.workspaceId, {
					text: input.text,
					modelId,
					...(session.taskAccess === "read_only" ? { readOnly: true } : {}),
					...(reasoningEffort ? { reasoningEffort } : {}),
					...(serviceTier ? { serviceTier } : {}),
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
		const hasCodexAuth = yield* Effect.tryPromise(() =>
			hasManagedCodexAuth(scope.userId),
		);
		if (!scope.projectId) return emptyCodexSession(hasCodexAuth);
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
					emptyCodexSession(hasCodexAuth),
				),
			);
		}
		const savedSession = peeked.session;
		const runtime = savedSession
			? yield* Effect.tryPromise(() =>
					codexRuntimeForSession(machines, { ...savedSession, providerRef }),
				)
			: { machines, workspaceId: WorkspaceId(providerRef) };
		const running = yield* Effect.tryPromise(() =>
			runtime.machines.isRunning(runtime.workspaceId),
		);
		if (!running) {
			yield* Effect.tryPromise(() =>
				persistSessionTurnStatus(peeked.session, "idle"),
			);
			const paused = yield* Effect.tryPromise(() =>
				persistBoundSessionView(
					peeked.session,
					pausedCodexSessionView(providerRef, hasCodexAuth),
				),
			);
			return { ...paused, turnStatus: "idle" as const };
		}
		const status = yield* interruptCodexTurn(
			runtime.machines,
			runtime.workspaceId,
		);
		return yield* Effect.tryPromise(() =>
			persistBoundSessionView(
				peeked.session,
				viewFromStatus(status, providerRef, hasCodexAuth),
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
		const hasCodexAuth = yield* Effect.tryPromise(() =>
			hasManagedCodexAuth(scope.userId),
		);
		if (!scope.projectId) return emptyCodexSession(hasCodexAuth);
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
		const result = yield* run(bound.providerRef, hasCodexAuth, bound.session);
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
	userId: string,
): Effect.Effect<CodexLoginStatus> {
	return Effect.gen(function* () {
		if (yield* Effect.tryPromise(() => hasManagedCodexAuth(userId))) {
			const tokens = yield* Effect.tryPromise(() =>
				codexExternalTokens(userId),
			);
			return yield* configureCodexExternalAuth(machines, workspaceId, tokens);
		}
		return yield* startInteractiveDeviceCodeLogin(machines, workspaceId, {
			skipInitialTurn: true,
		});
	}).pipe(
		Effect.catchAll((cause) =>
			Effect.succeed({
				stage: "failed" as const,
				message: publicFailureMessage(cause),
			}),
		),
	);
}

function promoteCodexLogin(
	machines: WorkspaceMachines,
	workspaceId: WorkspaceId,
	userId: string,
	status: Extract<CodexLoginStatus, { stage: "authenticated" }>,
): Effect.Effect<CodexLoginStatus, Error> {
	return Effect.gen(function* () {
		if (yield* Effect.tryPromise(() => hasManagedCodexAuth(userId))) {
			return status;
		}
		yield* Effect.tryPromise(() =>
			captureManagedCodexAuth(userId, machines, workspaceId, status.planType),
		);
		return yield* authenticatePreparedWorkspace(machines, workspaceId, userId);
	});
}

export async function serviceCodexRefreshRequest(
	machines: WorkspaceMachines,
	workspaceId: WorkspaceId,
	userId: string,
): Promise<void> {
	const contents = await machines.readTextFile(
		workspaceId,
		CODEX_REFRESH_REQUEST_PATH,
	);
	if (!contents) return;
	const claimPath = `${CODEX_REFRESH_REQUEST_PATH}.claimed`;
	const claimed = await machines.exec(
		workspaceId,
		`mv ${CODEX_REFRESH_REQUEST_PATH} ${claimPath}`,
		15_000,
	);
	if (claimed.exitCode !== 0) return;
	try {
		const claimedContents = await machines.readTextFile(workspaceId, claimPath);
		const request = JSON.parse(claimedContents ?? "null") as unknown;
		const id =
			request && typeof request === "object" && "id" in request
				? request.id
				: null;
		if (typeof id !== "string") return;
		try {
			const tokens = await codexExternalTokens(userId, true);
			await machines.writeTextFile(
				workspaceId,
				CODEX_REFRESH_RESPONSE_PATH,
				`${JSON.stringify({ id, tokens })}\n`,
			);
		} catch {
			await machines.writeTextFile(
				workspaceId,
				CODEX_REFRESH_RESPONSE_PATH,
				`${JSON.stringify({ id, error: "Codex login refresh failed." })}\n`,
			);
		}
	} finally {
		await machines
			.exec(workspaceId, `rm -f ${claimPath}`, 15_000)
			.catch(() => undefined);
	}
}

function prepareCodexGuest(
	machines: WorkspaceMachines,
	workspaceId: WorkspaceId,
	scope: CodexSessionScope,
): Effect.Effect<void, Error> {
	return Effect.gen(function* () {
		yield* preparePreparedGuest(machines, workspaceId, scope);
		beginSharedDesktop(machines, scope);
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
		usage: status.stage === "authenticated" ? status.usage : undefined,
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
