import { Effect } from "effect";
import type { AgentConnection } from "#/domain/agent-connection";
import {
	type AgentProviderId,
	agentProviderById,
} from "#/domain/agent-provider";
import { failureMessage } from "#/domain/failure-message";
import { canResumeDisconnectedFollowUp } from "#/domain/harness-access";
import { WorkspaceId } from "#/domain/ids";
import { submittedListedModelId } from "#/domain/listed-model";
import { harnessConnectBlockedReason } from "#/domain/project-workspace";
import { sessionRecordHasConversation } from "#/domain/session-item";
import { canSubmitComposer, canSubmitSideChat } from "#/domain/session-policy";
import type { WorkspaceLifecycle } from "#/domain/workspace";
import {
	type AgentSessionRecord,
	childAgentSession,
} from "#/server/adapters/agent-sessions";
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
	bindAgentSessionMachine,
	peekAgentSessionMachine,
	syncProjectContextForTask,
} from "./agent-session-machine";
import {
	type CodexSessionScope,
	connectCodexWorkspaceSession,
	emptyCodexSession,
	type PublicCodexSession,
	readCodexWorkspaceSession,
	sendCodexWorkspaceTask,
	stopCodexWorkspaceTurn,
} from "./codex-workspace-session";
import { persistBoundSessionView } from "./persist-session-view";
import { preparePreparedGuest } from "./project-workspace";
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

/**
 * Renders the stored agent transcript without starting a paused VM.
 * Connect wakes the machine when the user actually resumes that chat.
 */
export function readHarnessWorkspaceSession(
	machines: WorkspaceMachines,
	scope: HarnessSessionScope,
): Effect.Effect<PublicHarnessSession> {
	if (scope.harnessId === "codex") {
		return readCodexWorkspaceSession(machines, scope);
	}
	return withSessionMachine(machines, scope, false, (providerRef, session) => {
		if (scope.harnessId === "claude") {
			return refreshClaudeAuthStatus(machines, WorkspaceId(providerRef)).pipe(
				Effect.map((status) => viewFromClaude(status, providerRef)),
				Effect.flatMap((view) =>
					Effect.tryPromise(() => persistBoundSessionView(session, view)),
				),
				Effect.flatMap((view) => attachSiblingSideChat(machines, scope, view)),
			);
		}
		return refreshOpenCodeAuthStatus(machines, WorkspaceId(providerRef)).pipe(
			Effect.map((status) => viewFromOpenCode(status, providerRef)),
			Effect.flatMap((view) =>
				Effect.tryPromise(() => persistBoundSessionView(session, view)),
			),
			Effect.flatMap((view) => attachSiblingSideChat(machines, scope, view)),
		);
	});
}

/**
 * Starts the selected harness on this agent session's VM. Stored keys are
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
		if (blocked || !workspace?.providerRef || !scope.projectId) {
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
		const bound = yield* Effect.tryPromise(() =>
			bindAgentSessionMachine(machines, {
				userId: scope.userId,
				projectId: scope.projectId as string,
				harness: scope.harnessId,
				sessionId: scope.sessionId,
				createNew: scope.createNew,
			}),
		);
		yield* Effect.tryPromise(() =>
			machines.ensureRunning(WorkspaceId(bound.providerRef)),
		);
		yield* preparePreparedGuest(
			machines,
			WorkspaceId(bound.providerRef),
			scope,
		);
		const apiKey = yield* Effect.tryPromise(() =>
			decryptHarnessApiKey(scope.harnessId),
		);
		if (scope.harnessId === "claude") {
			const status = yield* connectClaudeCode(
				machines,
				WorkspaceId(bound.providerRef),
				apiKey,
			);
			return yield* Effect.tryPromise(() =>
				persistBoundSessionView(
					bound.session,
					viewFromClaude(status, bound.providerRef),
				),
			);
		}
		const status = yield* connectOpenCode(
			machines,
			WorkspaceId(bound.providerRef),
			apiKey,
			{
				discardCopiedTranscript: !sessionRecordHasConversation(
					bound.session.items,
				),
			},
		);
		return yield* Effect.tryPromise(() =>
			persistBoundSessionView(
				bound.session,
				viewFromOpenCode(status, bound.providerRef),
			),
		);
	}).pipe(
		Effect.catchAll((cause) =>
			Effect.succeed({
				...emptyHarnessSession(),
				connection: {
					status: "failed" as const,
					provider: scope.harnessId,
					message: failureMessage(cause),
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
	if (input.lane === "side") {
		return sendHarnessSideTask(machines, scope, input);
	}
	return withSessionMachine(machines, scope, true, (providerRef, session) =>
		submitConnectedHarnessTask(
			machines,
			scope,
			providerRef,
			session,
			input,
		).pipe(
			Effect.flatMap((view) => attachSiblingSideChat(machines, scope, view)),
		),
	);
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

/**
 * Send/connect start the session VM. Read returns the stored transcript
 * when that VM is paused so switching chats does not wait on a boot.
 */
function withSessionMachine(
	machines: WorkspaceMachines,
	scope: HarnessSessionScope,
	provision: boolean,
	run: (
		providerRef: string,
		session: Awaited<ReturnType<typeof peekAgentSessionMachine>>["session"],
	) => Effect.Effect<PublicHarnessSession, unknown>,
): Effect.Effect<PublicHarnessSession> {
	return Effect.gen(function* () {
		if (!scope.projectId) return emptyHarnessSession();
		const bound = provision
			? yield* Effect.tryPromise(() =>
					bindAgentSessionMachine(machines, {
						userId: scope.userId,
						projectId: scope.projectId as string,
						harness: scope.harnessId,
						sessionId: scope.sessionId,
						createNew: scope.createNew,
					}),
				)
			: yield* Effect.tryPromise(() =>
					peekAgentSessionMachine({
						userId: scope.userId,
						projectId: scope.projectId as string,
						sessionId: scope.sessionId,
					}),
				);
		const providerRef = bound.providerRef;
		if (!providerRef) {
			return yield* Effect.tryPromise(() =>
				persistBoundSessionView(bound.session, emptyHarnessSession()),
			);
		}
		if (provision) {
			yield* Effect.tryPromise(() =>
				machines.ensureRunning(WorkspaceId(providerRef)),
			);
			return yield* run(providerRef, bound.session);
		}
		const running = yield* Effect.tryPromise(() =>
			machines.isRunning(WorkspaceId(providerRef)),
		);
		if (!running) {
			const paused = yield* Effect.tryPromise(() =>
				persistBoundSessionView(
					bound.session,
					pausedHarnessSessionView(scope, providerRef),
				),
			);
			return yield* attachSiblingSideChat(machines, scope, paused);
		}
		return yield* run(providerRef, bound.session).pipe(
			Effect.catchAll(() =>
				Effect.tryPromise(() =>
					persistBoundSessionView(bound.session, emptyHarnessSession()),
				),
			),
		);
	}).pipe(
		Effect.catchAll((cause) =>
			Effect.succeed({
				...emptyHarnessSession(),
				connection: {
					status: "failed" as const,
					provider: scope.harnessId,
					message: failureMessage(cause),
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
		agentSessionId: null,
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

/**
 * A follow-up on a paused VM starts that harness if needed, then submits.
 * Stored keys are attached during connect; they are not treated as signed in.
 */
function submitConnectedHarnessTask(
	machines: WorkspaceMachines,
	scope: HarnessSessionScope,
	providerRef: string,
	session: AgentSessionRecord | null,
	input: {
		readonly text: string;
		readonly modelId: string;
	},
): Effect.Effect<PublicHarnessSession, unknown> {
	return Effect.gen(function* () {
		yield* preparePreparedGuest(machines, WorkspaceId(providerRef), scope);
		const promptText = yield* Effect.tryPromise(() =>
			scope.projectId
				? syncProjectContextForTask(machines, providerRef, {
						projectId: scope.projectId,
						task: input.text,
					})
				: Promise.resolve(input.text),
		);
		const payload = { ...input, promptText };
		const apiKey = yield* Effect.tryPromise(() =>
			decryptHarnessApiKey(scope.harnessId),
		);
		if (scope.harnessId === "claude") {
			let status = yield* refreshClaudeAuthStatus(
				machines,
				WorkspaceId(providerRef),
			);
			if (status.stage !== "authenticated") {
				status = yield* connectClaudeCode(
					machines,
					WorkspaceId(providerRef),
					apiKey,
				);
			}
			if (status.stage === "authenticated") {
				const modelId = submittedListedModelId(input.modelId, status.models);
				if (modelId) {
					status = yield* submitClaudeTask(machines, WorkspaceId(providerRef), {
						...payload,
						modelId,
					});
				}
			}
			return yield* Effect.tryPromise(() =>
				persistBoundSessionView(session, viewFromClaude(status, providerRef)),
			);
		}
		let status = yield* refreshOpenCodeAuthStatus(
			machines,
			WorkspaceId(providerRef),
		);
		if (status.stage !== "authenticated") {
			status = yield* connectOpenCode(
				machines,
				WorkspaceId(providerRef),
				apiKey,
				{
					discardCopiedTranscript: !sessionRecordHasConversation(
						session?.items,
					),
				},
			);
		}
		if (status.stage === "authenticated") {
			const modelId = submittedListedModelId(input.modelId, status.models);
			if (modelId) {
				status = yield* submitOpenCodeTask(machines, WorkspaceId(providerRef), {
					...payload,
					modelId,
				});
			}
		}
		return yield* Effect.tryPromise(() =>
			persistBoundSessionView(session, viewFromOpenCode(status, providerRef)),
		);
	});
}

/**
 * Side chat is a second agent session VM copied from the same project
 * snapshot. It does not share the main agent's checkout.
 */
function sendHarnessSideTask(
	machines: WorkspaceMachines,
	scope: HarnessSessionScope,
	input: {
		readonly text: string;
		readonly modelId: string;
	},
): Effect.Effect<PublicHarnessSession> {
	return Effect.gen(function* () {
		if (!scope.projectId || !scope.sessionId) {
			return {
				...emptyHarnessSession(),
				connection: {
					status: "failed" as const,
					provider: scope.harnessId,
					message: "Open a chat before starting a side agent.",
				},
			};
		}
		const existing = yield* Effect.tryPromise(() =>
			childAgentSession(scope.userId, scope.sessionId as string),
		);
		const bound = yield* Effect.tryPromise(() =>
			bindAgentSessionMachine(machines, {
				userId: scope.userId,
				projectId: scope.projectId as string,
				harness: scope.harnessId,
				sessionId: existing?.id,
				createNew: !existing,
				parentSessionId: scope.sessionId,
				task: input.text,
			}),
		);
		yield* Effect.tryPromise(() =>
			machines.ensureRunning(WorkspaceId(bound.providerRef)),
		);
		const sideView = yield* submitConnectedHarnessTask(
			machines,
			scope,
			bound.providerRef,
			bound.session,
			input,
		);
		const peeked = yield* Effect.tryPromise(() =>
			peekAgentSessionMachine({
				userId: scope.userId,
				projectId: scope.projectId as string,
				sessionId: scope.sessionId,
			}),
		);
		const parentRef = peeked.providerRef;
		const parentRunning = parentRef
			? yield* Effect.tryPromise(() =>
					machines.isRunning(WorkspaceId(parentRef)),
				)
			: false;
		const main = parentRunning
			? yield* readHarnessWorkspaceSession(machines, {
					...scope,
					createNew: false,
				})
			: yield* Effect.tryPromise(() =>
					persistBoundSessionView(
						peeked.session,
						pausedHarnessSessionView(scope, parentRef ?? "pending"),
					),
				);
		return mergeSideChat(main, sideView, scope.harnessId);
	}).pipe(
		Effect.catchAll((cause) =>
			Effect.succeed({
				...emptyHarnessSession(),
				connection: {
					status: "failed" as const,
					provider: scope.harnessId,
					message: failureMessage(cause),
				},
			}),
		),
	);
}

function attachSiblingSideChat(
	machines: WorkspaceMachines,
	scope: HarnessSessionScope,
	main: PublicHarnessSession,
): Effect.Effect<PublicHarnessSession> {
	if (!scope.sessionId) {
		return Effect.succeed(mergeSideChat(main, null, scope.harnessId));
	}
	return Effect.gen(function* () {
		const child = yield* Effect.tryPromise(() =>
			childAgentSession(scope.userId, scope.sessionId as string),
		);
		if (!child?.providerRef) {
			return mergeSideChat(main, null, scope.harnessId);
		}
		const running = yield* Effect.tryPromise(() =>
			machines.isRunning(WorkspaceId(child.providerRef as string)),
		);
		if (!running) {
			const stored = yield* Effect.tryPromise(() =>
				persistBoundSessionView(child, emptyHarnessSession()),
			);
			return mergeSideChat(main, stored, scope.harnessId);
		}
		if (scope.harnessId === "claude") {
			const status = yield* refreshClaudeAuthStatus(
				machines,
				WorkspaceId(child.providerRef),
			);
			const side = yield* Effect.tryPromise(() =>
				persistBoundSessionView(
					child,
					viewFromClaude(status, child.providerRef as string),
				),
			);
			return mergeSideChat(main, side, scope.harnessId);
		}
		const status = yield* refreshOpenCodeAuthStatus(
			machines,
			WorkspaceId(child.providerRef),
		);
		const side = yield* Effect.tryPromise(() =>
			persistBoundSessionView(
				child,
				viewFromOpenCode(status, child.providerRef as string),
			),
		);
		return mergeSideChat(main, side, scope.harnessId);
	}).pipe(
		Effect.catchAll(() =>
			Effect.succeed(mergeSideChat(main, null, scope.harnessId)),
		),
	);
}

function mergeSideChat(
	main: PublicHarnessSession,
	side: PublicHarnessSession | null,
	harnessId: AgentProviderId,
): PublicHarnessSession {
	const workspace: WorkspaceLifecycle = {
		status: "running",
		workspaceId: WorkspaceId(
			side?.workspaceId ?? main.workspaceId ?? "pending",
		),
	};
	const canResumeSide = canResumeDisconnectedFollowUp({
		harnessId,
		connection: main.connection,
		turnStatus: main.turnStatus,
		snapshotAvailable: main.snapshotAvailable,
	});
	if (!side) {
		return {
			...main,
			canSendSide:
				canSubmitSideChat(workspace, main.connection, "idle") || canResumeSide,
		};
	}
	return {
		...main,
		sideItems: side.items,
		sideTurnStatus: side.turnStatus,
		canSendSide:
			canSubmitSideChat(
				workspace,
				side.connection.status === "authenticated"
					? side.connection
					: main.connection,
				side.turnStatus,
			) || canResumeSide,
	};
}

function pausedHarnessSessionView(
	scope: HarnessSessionScope,
	workspaceId: string,
): PublicHarnessSession {
	const view = emptyHarnessSession();
	return {
		...view,
		workspaceId,
		canSendSide: canResumeDisconnectedFollowUp({
			harnessId: scope.harnessId,
			connection: view.connection,
			turnStatus: "idle",
			snapshotAvailable: view.snapshotAvailable,
		}),
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
