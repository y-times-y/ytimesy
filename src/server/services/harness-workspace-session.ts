import { Duration, Effect } from "effect";
import type { AgentConnection } from "#/domain/agent-connection";
import {
	type AgentProviderId,
	agentProviderById,
} from "#/domain/agent-provider";
import { agentTaskTree } from "#/domain/agent-task";
import {
	AGENT_TASK_TOOL_REQUEST_PATH,
	AGENT_TASK_TOOL_RESPONSE_PATH,
	parseAgentTaskToolRequest,
	serializeAgentTaskToolResponse,
	taskToolAccess,
	taskToolExecution,
	taskToolHarness,
	taskToolPlacement,
	taskToolString,
} from "#/domain/agent-task-tool";
import {
	claudeSessionRemembersSignIn,
	rememberedClaudeModels,
} from "#/domain/claude-auth";
import { canResumeDisconnectedFollowUp } from "#/domain/harness-access";
import { WorkspaceId } from "#/domain/ids";
import {
	listedFastModeId,
	listedModelDisplayName,
	listedModelPreferenceFromSessions,
	modelIdToSubmit,
	preferredListedModelId,
} from "#/domain/listed-model";
import {
	harnessConnectBlockedReason,
	publicFailureMessage,
} from "#/domain/project-workspace";
import {
	lastAgentMessageText,
	sessionItemsFromUnknown,
	sessionRecordHasConversation,
} from "#/domain/session-item";
import { canSubmitComposer, canSubmitSideChat } from "#/domain/session-policy";
import type { WorkspaceLifecycle } from "#/domain/workspace";
import {
	type AgentSessionRecord,
	agentSessionForOwner,
	descendantAgentSessions,
	listUserProviderRefs,
	saveAgentTaskPublication,
	saveAgentTaskReview,
	saveAgentTaskState,
	sideAgentSession,
} from "#/server/adapters/agent-sessions";
import {
	claimAgentTaskCommand,
	completeAgentTaskCommand,
	renewAgentTaskCommandClaim,
} from "#/server/adapters/agent-task-command-receipts";
import { saveAgentTaskBlockedEvent } from "#/server/adapters/agent-task-events";
import { captureClaudeHome } from "#/server/adapters/claude/home-files";
import {
	type ClaudeAuthStatus,
	connectClaudeCode,
	refreshClaudeAuthStatus,
	submitClaudeAuthCode,
	submitClaudeTask,
} from "#/server/adapters/claude/login-session";
import {
	abortOpenCodeTurn,
	connectOpenCode,
	type OpenCodeAuthStatus,
	refreshOpenCodeAuthStatus,
	submitOpenCodeTask,
} from "#/server/adapters/opencode/serve-session";
import { readyWorkspaceForOwner } from "#/server/adapters/workspaces";
import { enqueueAgentTaskEvent } from "#/server/jobs/queue";
import {
	persistClaudeAuthSnapshotForUser,
	refreshClaudeAuthSnapshotForUser,
} from "#/server/proof/persist-claude-auth-snapshot";
import { decryptHarnessApiKey } from "#/server/secrets/harness-key-store";
import {
	bindAgentSessionMachine,
	bindPreparedAgentTaskMachine,
	editAgentTaskDraft,
	openAgentTask,
	peekAgentSessionMachine,
	prepareAgentTaskStart,
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
import {
	persistBoundSessionView,
	persistQueuedUserTurn,
	persistSessionTurnStatus,
} from "./persist-session-view";
import { preparePreparedGuest } from "./project-workspace";
import { publishProject } from "./publication";
import { machinesForAgentSession } from "./session-workspace-machines";
import { beginSharedDesktop } from "./workspace-desktop";
import type { WorkspaceMachines } from "./workspace-machines";

export type HarnessSessionScope = CodexSessionScope & {
	readonly harnessId: AgentProviderId;
};

export type PublicHarnessSession = PublicCodexSession;

export function startPreparedAgentTask(
	machines: WorkspaceMachines,
	scope: HarnessSessionScope,
	taskSessionId: string,
): Effect.Effect<
	{ id: string; machineId: string; placement: "shared" | "fresh" },
	unknown
> {
	return Effect.gen(function* () {
		if (!scope.projectId) throw new Error("The project is not available.");
		const { task, predecessor } = yield* Effect.tryPromise(() =>
			prepareAgentTaskStart({
				userId: scope.userId,
				projectId: scope.projectId as string,
				taskSessionId,
			}),
		);
		if (!task.taskPrompt || !task.listedModelId || !task.taskPlacement) {
			throw new Error(
				"The task draft is missing its prompt, model, or placement.",
			);
		}
		const taskMachines = machinesForAgentSession(machines, task);
		const bound = yield* Effect.gen(function* () {
			const machine = yield* Effect.tryPromise(() =>
				bindPreparedAgentTaskMachine(taskMachines, {
					userId: scope.userId,
					projectId: scope.projectId as string,
					task,
					predecessor,
				}),
			);
			yield* sendHarnessWorkspaceTask(taskMachines, taskScope(scope, task), {
				text: task.taskPrompt as string,
				modelId: task.listedModelId as string,
			});
			return machine;
		}).pipe(
			Effect.tapError(() =>
				Effect.tryPromise(() => saveAgentTaskState(task.id, "failed")),
			),
		);
		return {
			id: task.id,
			machineId: bound.providerRef,
			placement: task.taskPlacement as "shared" | "fresh",
		};
	});
}

export function requestAgentTaskWrapUp(
	machines: WorkspaceMachines,
	scope: HarnessSessionScope,
	taskSessionId: string,
	modelId?: string,
): Effect.Effect<{ id: string }, unknown> {
	return Effect.gen(function* () {
		const task = yield* Effect.tryPromise(() =>
			agentSessionForOwner(scope.userId, taskSessionId),
		);
		if (!task || task.projectId !== scope.projectId || !task.parentSessionId) {
			throw new Error("The task is not available.");
		}
		if (task.harness === "claude" && task.turnStatus === "running") {
			throw new Error(
				"This runtime cannot be interrupted safely yet. Wait for its current turn before requesting a wrap-up.",
			);
		}
		const selectedModel = modelId || task.listedModelId;
		if (!selectedModel) throw new Error("The task has no model selection.");
		const taskMachines = machinesForAgentSession(machines, task);
		const targetScope = taskScope(scope, task);
		yield* stopHarnessWorkspaceTurn(taskMachines, targetScope);
		yield* sendHarnessWorkspaceTask(taskMachines, targetScope, {
			modelId: selectedModel,
			text: "Wrap up now. Stop expanding scope, preserve useful work, run only essential verification, and return a concise result with evidence and remaining uncertainty.",
		});
		return { id: task.id };
	});
}

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
	return serviceAgentTaskToolRequest(machines, scope).pipe(
		Effect.flatMap(() => readHarnessWorkspaceSessionView(machines, scope)),
	);
}

function readHarnessWorkspaceSessionView(
	machines: WorkspaceMachines,
	scope: HarnessSessionScope,
): Effect.Effect<PublicHarnessSession> {
	if (scope.harnessId === "codex") {
		return withSiblingSideChat(
			machines,
			scope,
			readCodexWorkspaceSession(machines, scope),
		);
	}
	return withSessionMachine(machines, scope, false, (providerRef, session) => {
		if (scope.harnessId === "claude") {
			return refreshClaudeAuthStatus(machines, WorkspaceId(providerRef)).pipe(
				Effect.tap((status) =>
					rememberClaudeHome(
						machines,
						WorkspaceId(providerRef),
						scope.userId,
						status,
					),
				),
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
 * Starts the selected harness on this agent session's VM. Claude Sign in
 * only resumes or copies that VM and starts Anthropic's login. Checkout
 * waits for Send. Stored keys never count as signed in on their own.
 */
export function connectHarnessWorkspaceSession(
	machines: WorkspaceMachines,
	scope: HarnessSessionScope,
): Effect.Effect<PublicHarnessSession> {
	if (scope.harnessId === "codex") {
		return withSiblingSideChat(
			machines,
			scope,
			connectCodexWorkspaceSession(machines, scope),
		);
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
		if (blocked || !scope.projectId) {
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
		if (scope.harnessId !== "claude") {
			yield* preparePreparedGuest(
				machines,
				WorkspaceId(bound.providerRef),
				scope,
			);
		}
		beginSharedDesktop(machines, scope);
		const apiKey = yield* Effect.tryPromise(() =>
			decryptHarnessApiKey(scope.harnessId),
		);
		if (scope.harnessId === "claude") {
			const siblings = yield* Effect.tryPromise(() =>
				listUserProviderRefs(scope.userId, bound.providerRef),
			);
			const status = yield* connectClaudeCode(
				machines,
				WorkspaceId(bound.providerRef),
				apiKey,
				{ userId: scope.userId, siblingProviderRefs: siblings },
			);
			yield* rememberClaudeHome(
				machines,
				WorkspaceId(bound.providerRef),
				scope.userId,
				status,
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
					message: publicFailureMessage(cause),
				},
			}),
		),
	);
}

/**
 * Completes Claude Code on the same login PTY. Anthropic's paste-back code
 * is bound to that PKCE session; starting a second login would reject it.
 */
export function completeClaudeWorkspaceAuth(
	machines: WorkspaceMachines,
	scope: HarnessSessionScope,
	code: string,
): Effect.Effect<PublicHarnessSession> {
	if (scope.harnessId !== "claude") {
		return Effect.succeed({
			...emptyHarnessSession(),
			connection: {
				status: "failed" as const,
				provider: scope.harnessId,
				message: "Only Claude Code uses a pasted Anthropic login code.",
			},
		});
	}
	return withSessionMachine(machines, scope, true, (providerRef, session) =>
		submitClaudeAuthCode(machines, WorkspaceId(providerRef), code).pipe(
			Effect.tap((status) =>
				rememberClaudeHome(
					machines,
					WorkspaceId(providerRef),
					scope.userId,
					status,
					"replace",
				),
			),
			Effect.flatMap((status) =>
				Effect.tryPromise(() =>
					persistBoundSessionView(session, viewFromClaude(status, providerRef)),
				),
			),
		),
	).pipe(
		Effect.catchAll((cause) =>
			Effect.succeed({
				...emptyHarnessSession(),
				connection: {
					status: "failed" as const,
					provider: "claude" as const,
					message: publicFailureMessage(cause),
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
		readonly variant?: string;
		readonly fast?: boolean;
	},
): Effect.Effect<PublicHarnessSession> {
	if (input.lane === "side") {
		return sendHarnessSideTask(machines, scope, input);
	}
	if (scope.harnessId === "codex") {
		return queueHarnessTurn(
			machines,
			scope,
			input.text,
			sendCodexWorkspaceTask(machines, scope, input),
		);
	}
	return queueHarnessTurn(
		machines,
		scope,
		input.text,
		withSessionMachine(machines, scope, true, (providerRef, session) =>
			submitConnectedHarnessTask(
				machines,
				scope,
				providerRef,
				session,
				input,
			).pipe(
				Effect.flatMap((view) => attachSiblingSideChat(machines, scope, view)),
			),
		),
	);
}

/**
 * Persists the user turn before provisioning, then waits only until the
 * provider accepts the request. Turn supervision continues in the background.
 */
function queueHarnessTurn(
	machines: WorkspaceMachines,
	scope: HarnessSessionScope,
	text: string,
	submit: Effect.Effect<PublicHarnessSession>,
): Effect.Effect<PublicHarnessSession> {
	return Effect.gen(function* () {
		if (!scope.projectId) return emptyHarnessSession();
		const peeked = yield* Effect.tryPromise(() =>
			peekAgentSessionMachine({
				userId: scope.userId,
				projectId: scope.projectId as string,
				sessionId: scope.sessionId,
			}),
		);
		const queued = yield* Effect.tryPromise(() =>
			persistQueuedUserTurn(
				peeked.session,
				peeked.providerRef
					? pausedHarnessSessionView(scope, peeked.providerRef, peeked.session)
					: {
							...emptyHarnessSession(),
							items: sessionItemsFromUnknown(peeked.session?.items),
						},
				text,
			),
		);
		const launched = yield* submit.pipe(
			Effect.flatMap((view) =>
				Effect.tryPromise(() =>
					persistBoundSessionView(peeked.session, {
						...view,
						items: queued.items,
					}),
				),
			),
			Effect.catchAll((cause) =>
				Effect.tryPromise(() =>
					persistBoundSessionView(peeked.session, {
						...queued,
						turnStatus: "failed",
						connection: {
							status: "failed",
							provider: scope.harnessId,
							message: publicFailureMessage(cause),
						},
					}),
				),
			),
		);
		if (launched.turnStatus === "running") {
			void Effect.runPromise(
				superviseHarnessTurn(machines, scope, launched).pipe(
					Effect.catchAll(() => Effect.void),
				),
			);
		}
		return yield* attachSiblingSideChat(machines, scope, launched);
	}).pipe(
		Effect.catchAll((cause) =>
			Effect.succeed({
				...emptyHarnessSession(),
				connection: {
					status: "failed" as const,
					provider: scope.harnessId,
					message: publicFailureMessage(cause),
				},
			}),
		),
	);
}

const TASK_SUPERVISION_POLLS = 1_800;
const activeAgentTaskToolRequests = new Set<string>();

/**
 * Keeps provider state and task-tool requests moving after the browser closes.
 * The VM remains the execution boundary; the control plane owns orchestration.
 */
function superviseHarnessTurn(
	machines: WorkspaceMachines,
	scope: HarnessSessionScope,
	initial: PublicHarnessSession,
): Effect.Effect<PublicHarnessSession> {
	return Effect.gen(function* () {
		let current = initial;
		for (
			let poll = 0;
			poll < TASK_SUPERVISION_POLLS && current.turnStatus === "running";
			poll += 1
		) {
			yield* serviceAgentTaskToolRequest(machines, scope);
			yield* Effect.sleep(Duration.seconds(1));
			current = yield* readHarnessWorkspaceSessionView(machines, {
				...scope,
				createNew: false,
			});
		}
		return current;
	});
}

/**
 * Drains one provider-local request. The bound session scopes every operation,
 * so a model cannot address another user's task by guessing an identifier.
 */
function serviceAgentTaskToolRequest(
	machines: WorkspaceMachines,
	scope: HarnessSessionScope,
): Effect.Effect<void> {
	return Effect.gen(function* () {
		if (!scope.projectId || !scope.sessionId) return;
		const parent = yield* Effect.tryPromise(() =>
			agentSessionForOwner(scope.userId, scope.sessionId as string),
		);
		if (
			!parent ||
			parent.projectId !== scope.projectId ||
			!parent.providerRef
		) {
			return;
		}
		const workspaceId = WorkspaceId(parent.providerRef);
		const requestText = yield* Effect.tryPromise(() =>
			machines.readTextFile(workspaceId, AGENT_TASK_TOOL_REQUEST_PATH),
		).pipe(Effect.catchAll(() => Effect.succeed(null)));
		const request = parseAgentTaskToolRequest(requestText);
		if (!request) return;
		const responseText = yield* Effect.tryPromise(() =>
			machines.readTextFile(workspaceId, AGENT_TASK_TOOL_RESPONSE_PATH),
		).pipe(Effect.catchAll(() => Effect.succeed(null)));
		if (agentTaskToolResponseId(responseText) === request.id) return;
		const receipt = yield* Effect.tryPromise(() =>
			claimAgentTaskCommand(parent.id, request.id),
		);
		if (receipt.kind === "processing") return;
		if (receipt.kind === "done") {
			yield* Effect.tryPromise(() =>
				machines.writeTextFile(
					workspaceId,
					AGENT_TASK_TOOL_RESPONSE_PATH,
					serializeAgentTaskToolResponse(receipt.response),
				),
			);
			return;
		}
		const inFlightKey = `${parent.id}:${request.id}`;
		if (activeAgentTaskToolRequests.has(inFlightKey)) return;
		activeAgentTaskToolRequests.add(inFlightKey);
		const heartbeat = setInterval(
			() =>
				void renewAgentTaskCommandClaim(parent.id, request.id).catch(
					() => undefined,
				),
			10_000,
		);
		heartbeat.unref();
		yield* Effect.gen(function* () {
			const response = yield* runAgentTaskTool(
				machines,
				scope,
				parent,
				request,
			).pipe(
				Effect.map((result) => ({ id: request.id, ok: true as const, result })),
				Effect.catchAll((cause) =>
					Effect.succeed({
						id: request.id,
						ok: false as const,
						error: publicFailureMessage(cause),
					}),
				),
			);
			yield* Effect.tryPromise(() =>
				completeAgentTaskCommand(parent.id, response),
			);
			yield* Effect.tryPromise(() =>
				machines.writeTextFile(
					workspaceId,
					AGENT_TASK_TOOL_RESPONSE_PATH,
					serializeAgentTaskToolResponse(response),
				),
			);
		}).pipe(
			Effect.ensuring(
				Effect.sync(() => {
					clearInterval(heartbeat);
					activeAgentTaskToolRequests.delete(inFlightKey);
				}),
			),
		);
	}).pipe(Effect.catchAll(() => Effect.void));
}

function runAgentTaskTool(
	machines: WorkspaceMachines,
	scope: HarnessSessionScope,
	parent: AgentSessionRecord,
	request: NonNullable<ReturnType<typeof parseAgentTaskToolRequest>>,
): Effect.Effect<unknown, unknown> {
	return Effect.gen(function* () {
		if (!scope.projectId) throw new Error("The project is not available.");
		if (request.tool === "create_task") {
			const title = taskToolString(request.arguments, "title");
			const prompt = taskToolString(request.arguments, "prompt");
			if (!title || !prompt)
				throw new Error("Task title and prompt are required.");
			const harnessId = taskToolHarness(request.arguments, parent.harness);
			const modelId =
				taskToolString(request.arguments, "modelId") ||
				(harnessId === parent.harness ? parent.listedModelId : "") ||
				"";
			if (!modelId) {
				throw new Error(
					"Choose a model when starting a task on a different runtime.",
				);
			}
			const task = yield* Effect.tryPromise(() =>
				openAgentTask({
					userId: scope.userId,
					projectId: scope.projectId as string,
					parentSessionId: parent.id,
					title,
					harness: harnessId,
					modelId,
					prompt,
					placement: taskToolPlacement(request.arguments),
					access: taskToolAccess(request.arguments),
					execution: taskToolExecution(request.arguments),
					dependsOnSessionId:
						taskToolString(request.arguments, "dependsOnTaskId") || null,
				}),
			);
			return {
				taskId: task.id,
				title: task.title,
				status: "draft",
				placement: task.taskPlacement,
				execution: task.taskExecution,
			};
		}
		if (request.tool === "report_task_blocked") {
			if (!parent.parentSessionId) {
				throw new Error("A root agent has no parent to notify.");
			}
			const question = taskToolString(request.arguments, "question");
			const eventId = yield* Effect.tryPromise(() =>
				saveAgentTaskBlockedEvent({ sessionId: parent.id, question }),
			);
			if (eventId) {
				yield* Effect.tryPromise(() =>
					enqueueAgentTaskEvent(eventId).catch(() => null),
				);
			}
			return { taskId: parent.id, status: "waiting" };
		}

		const descendants = yield* Effect.tryPromise(() =>
			descendantAgentSessions(scope.userId, parent.id),
		);
		const taskRows = descendants.filter((row) => row.title !== "Side chat");
		if (request.tool === "list_tasks") {
			const byId = new Map(taskRows.map((row) => [row.id, row]));
			return agentTaskTree(parent.id, taskRows).map((task) => ({
				...task,
				summary:
					task.summary ??
					lastAgentMessageText(
						sessionItemsFromUnknown(byId.get(task.id)?.items),
					),
			}));
		}

		const taskId = taskToolString(request.arguments, "taskId");
		const target = taskRows.find((row) => row.id === taskId);
		if (!target) throw new Error("That descendant task is not available.");
		if (request.tool === "edit_task") {
			const title = taskToolString(request.arguments, "title");
			const prompt = taskToolString(request.arguments, "prompt");
			const harness = taskToolHarness(request.arguments, target.harness);
			const modelId =
				taskToolString(request.arguments, "modelId") ||
				(harness === target.harness ? target.listedModelId : "");
			if (!modelId) throw new Error("Choose a model for the edited runtime.");
			const execution = taskToolString(request.arguments, "execution")
				? taskToolExecution(request.arguments)
				: target.taskExecution || "parallel";
			const edited = yield* Effect.tryPromise(() =>
				editAgentTaskDraft({
					userId: scope.userId,
					projectId: scope.projectId as string,
					taskSessionId: target.id,
					title,
					prompt,
					harness,
					modelId,
					placement: taskToolString(request.arguments, "placement")
						? taskToolPlacement(request.arguments)
						: target.taskPlacement || "fresh",
					access: taskToolString(request.arguments, "access")
						? taskToolAccess(request.arguments)
						: target.taskAccess || "read_write",
					execution,
					dependsOnSessionId:
						execution === "parallel"
							? null
							: Object.hasOwn(request.arguments, "dependsOnTaskId")
								? taskToolString(request.arguments, "dependsOnTaskId") || null
								: target.dependsOnSessionId,
				}),
			);
			return { taskId: edited.id, status: "draft" };
		}
		if (request.tool === "start_task") {
			const started = yield* startPreparedAgentTask(machines, scope, target.id);
			return {
				taskId: started.id,
				status: "working",
				placement: started.placement,
				machineId: started.machineId,
			};
		}
		if (request.tool === "inspect_task_diff") {
			if (!target.providerRef) {
				throw new Error("The task has no machine to inspect.");
			}
			const diff = yield* Effect.tryPromise(() =>
				machines.exec(
					WorkspaceId(target.providerRef as string),
					`set -eu
cd "$(cat /tmp/ytimesy-project-cwd)"
git status --short
git diff --stat
git diff -- .`,
					30_000,
				),
			);
			if (diff.exitCode !== 0) {
				throw new Error((diff.stderr || diff.stdout).trim() || "Diff failed.");
			}
			return {
				taskId: target.id,
				diff: diff.stdout.slice(0, 60_000),
				truncated: diff.stdout.length > 60_000,
			};
		}
		if (request.tool === "mark_task_reviewed") {
			if (target.taskState !== "done") {
				throw new Error("Only a completed task can be marked reviewed.");
			}
			const reviewed = yield* Effect.tryPromise(() =>
				saveAgentTaskReview(target.id, "reviewed"),
			);
			if (!reviewed) throw new Error("The task review could not be saved.");
			return { taskId: target.id, reviewState: "reviewed" };
		}
		if (request.tool === "publish_task") {
			if (
				target.taskState !== "done" ||
				target.taskReviewState !== "reviewed"
			) {
				throw new Error("Review the completed task before publishing it.");
			}
			if (target.taskAccess !== "read_write") {
				throw new Error("Read-only tasks have no changes to publish.");
			}
			const title = taskToolString(request.arguments, "title");
			if (!title) throw new Error("A pull request title is required.");
			const predecessor = target.dependsOnSessionId
				? taskRows.find((row) => row.id === target.dependsOnSessionId)
				: null;
			const published = yield* publishProject(scope.userId, {
				projectId: scope.projectId,
				sessionId: target.id,
				title,
				body: taskToolString(request.arguments, "body"),
				...(predecessor?.taskBranch
					? { baseBranch: predecessor.taskBranch }
					: {}),
			});
			const saved = yield* Effect.tryPromise(() =>
				saveAgentTaskPublication(target.id, {
					branch: published.head,
					pullRequestUrl: published.url,
				}),
			);
			if (!saved) throw new Error("The task publication could not be saved.");
			return {
				taskId: target.id,
				branch: published.head,
				pullRequestUrl: published.url,
			};
		}
		if (request.tool === "request_task_wrap_up") {
			const wrapped = yield* requestAgentTaskWrapUp(machines, scope, target.id);
			return { taskId: wrapped.id, status: "working" };
		}
		const targetMachines = machinesForAgentSession(machines, target);
		const message = taskToolString(request.arguments, "message");
		if (!message) throw new Error("A task message is required.");
		const modelId = target.listedModelId || parent.listedModelId || "";
		if (!modelId) throw new Error("The task has no model selection.");
		yield* sendHarnessWorkspaceTask(targetMachines, taskScope(scope, target), {
			text: message,
			modelId,
		});
		return { taskId: target.id, status: "working" };
	});
}

function taskScope(
	scope: HarnessSessionScope,
	task: AgentSessionRecord,
): HarnessSessionScope {
	return {
		userId: scope.userId,
		projectId: scope.projectId,
		sessionId: task.id,
		harnessId: task.harness,
		createNew: false,
	};
}

function agentTaskToolResponseId(text: string | null): string | null {
	if (!text?.trim()) return null;
	try {
		const value = JSON.parse(text) as { id?: unknown };
		return typeof value.id === "string" ? value.id : null;
	} catch {
		return null;
	}
}

export function stopHarnessWorkspaceTurn(
	machines: WorkspaceMachines,
	scope: HarnessSessionScope,
	input?: { readonly lane?: "main" | "side" },
): Effect.Effect<PublicHarnessSession> {
	if (input?.lane === "side") {
		return stopHarnessSideTurn(machines, scope);
	}
	if (scope.harnessId === "codex") {
		return stopCodexWorkspaceTurn(machines, scope);
	}
	if (scope.harnessId === "opencode") {
		return stopOpenCodeWorkspaceTurn(machines, scope);
	}
	return stopClaudeWorkspaceTurn(machines, scope);
}

/**
 * Abort talks to a live OpenCode serve. A paused VM is already stopped;
 * persist idle without booting so Stop does not consume compute allowance.
 */
function stopOpenCodeWorkspaceTurn(
	machines: WorkspaceMachines,
	scope: HarnessSessionScope,
): Effect.Effect<PublicHarnessSession> {
	return Effect.gen(function* () {
		if (!scope.projectId) return emptyHarnessSession();
		const bound = yield* Effect.tryPromise(() =>
			peekAgentSessionMachine({
				userId: scope.userId,
				projectId: scope.projectId as string,
				sessionId: scope.sessionId,
			}),
		);
		const providerRef = bound.providerRef;
		if (!providerRef) {
			return yield* persistIdleStoppedSession(bound.session, null);
		}
		const running = yield* Effect.tryPromise(() =>
			machines.isRunning(WorkspaceId(providerRef)),
		);
		if (!running) {
			const paused = yield* persistIdleStoppedSession(
				bound.session,
				pausedHarnessSessionView(scope, providerRef, bound.session),
			);
			return yield* attachSiblingSideChat(machines, scope, paused);
		}
		const status = yield* abortOpenCodeTurn(machines, WorkspaceId(providerRef));
		const view = yield* Effect.tryPromise(() =>
			persistBoundSessionView(
				bound.session,
				viewFromOpenCode(status, providerRef),
			),
		);
		return yield* attachSiblingSideChat(machines, scope, view);
	}).pipe(
		Effect.catchAll((cause) =>
			Effect.succeed({
				...emptyHarnessSession(),
				connection: {
					status: "failed" as const,
					provider: "opencode" as const,
					message: publicFailureMessage(cause),
				},
			}),
		),
	);
}

/**
 * Claude Code has no abort adapter yet. A paused VM is already stopped;
 * persist idle without booting so Stop does not consume compute allowance.
 */
function stopClaudeWorkspaceTurn(
	machines: WorkspaceMachines,
	scope: HarnessSessionScope,
): Effect.Effect<PublicHarnessSession> {
	return Effect.gen(function* () {
		if (!scope.projectId) return emptyHarnessSession();
		const bound = yield* Effect.tryPromise(() =>
			peekAgentSessionMachine({
				userId: scope.userId,
				projectId: scope.projectId as string,
				sessionId: scope.sessionId,
			}),
		);
		const providerRef = bound.providerRef;
		if (!providerRef) {
			return yield* persistIdleStoppedSession(bound.session, null);
		}
		const running = yield* Effect.tryPromise(() =>
			machines.isRunning(WorkspaceId(providerRef)),
		);
		if (!running) {
			const paused = yield* persistIdleStoppedSession(
				bound.session,
				pausedHarnessSessionView(scope, providerRef, bound.session),
			);
			return yield* attachSiblingSideChat(machines, scope, paused);
		}
		return yield* readHarnessWorkspaceSession(machines, scope);
	}).pipe(
		Effect.catchAll((cause) =>
			Effect.succeed({
				...emptyHarnessSession(),
				connection: {
					status: "failed" as const,
					provider: "claude" as const,
					message: publicFailureMessage(cause),
				},
			}),
		),
	);
}

function persistIdleStoppedSession(
	session: Awaited<ReturnType<typeof peekAgentSessionMachine>>["session"],
	view: PublicHarnessSession | null,
) {
	return Effect.gen(function* () {
		yield* Effect.tryPromise(() => persistSessionTurnStatus(session, "idle"));
		const persisted = yield* Effect.tryPromise(() =>
			persistBoundSessionView(
				session,
				view ?? { ...emptyHarnessSession(), turnStatus: "idle" },
			),
		);
		return { ...persisted, turnStatus: "idle" as const };
	});
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
					pausedHarnessSessionView(scope, providerRef, bound.session),
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
					message: publicFailureMessage(cause),
				},
			}),
		),
	);
}

function viewFromClaude(
	status: ClaudeAuthStatus,
	workspaceId: string,
): PublicHarnessSession {
	const models = status.stage === "authenticated" ? status.models : [];
	const view = viewFromConnection(
		connectionFromClaude(status),
		workspaceId,
		models,
		status.stage === "authenticated" ? status.turnStatus : "idle",
		status.stage === "authenticated" ? status.items : [],
	);
	return {
		...view,
		listedModelId:
			status.stage === "authenticated" ? preferredListedModelId(models) : "",
	};
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
		readonly variant?: string;
		readonly fast?: boolean;
	},
): Effect.Effect<PublicHarnessSession, unknown> {
	return Effect.gen(function* () {
		const followUp = sessionRecordHasConversation(session?.items);
		if (!followUp) {
			yield* preparePreparedGuest(machines, WorkspaceId(providerRef), scope);
		}
		beginSharedDesktop(machines, scope);
		const promptText =
			followUp || session?.parentSessionId
				? input.text
				: yield* Effect.tryPromise(() =>
						scope.projectId
							? syncProjectContextForTask(machines, providerRef, {
									projectId: scope.projectId,
									task: input.text,
								})
							: Promise.resolve(input.text),
					);
		const payload = { ...input, promptText };
		if (followUp) {
			void Effect.runPromise(
				preparePreparedGuest(machines, WorkspaceId(providerRef), scope).pipe(
					Effect.catchAll(() => Effect.void),
				),
			);
		}
		const apiKey = yield* Effect.tryPromise(() =>
			decryptHarnessApiKey(scope.harnessId),
		);
		if (scope.harnessId === "claude") {
			let status = yield* refreshClaudeAuthStatus(
				machines,
				WorkspaceId(providerRef),
			);
			if (status.stage !== "authenticated") {
				const siblings = yield* Effect.tryPromise(() =>
					listUserProviderRefs(scope.userId, providerRef),
				);
				status = yield* connectClaudeCode(
					machines,
					WorkspaceId(providerRef),
					apiKey,
					{ userId: scope.userId, siblingProviderRefs: siblings },
				);
			}
			yield* rememberClaudeHome(
				machines,
				WorkspaceId(providerRef),
				scope.userId,
				status,
				false,
			);
			let listedModelId = "";
			if (status.stage === "authenticated") {
				const preference = listedModelPreferenceFromSessions({
					harness: session?.harness ?? scope.harnessId,
					sessions: session
						? [
								{
									harness: session.harness,
									listedModelId: session.listedModelId,
									items: session.items,
								},
							]
						: [],
				});
				listedModelId = modelIdToSubmit(input.modelId, status.models, {
					lastUsedId: preference.listedModelId,
					excludedIds: preference.blockedListedModelIds,
				});
				if (!listedModelId) {
					return yield* Effect.tryPromise(() =>
						persistBoundSessionView(session, {
							...viewFromClaude(status, providerRef),
							connection: {
								status: "failed",
								provider: "claude",
								message: "Claude Code did not list a model to run.",
							},
						}),
					);
				}
				yield* Effect.tryPromise(() =>
					persistSessionTurnStatus(session, "running"),
				);
				status = yield* submitClaudeTask(machines, WorkspaceId(providerRef), {
					...payload,
					modelId: listedModelId,
					...(input.variant ? { reasoningEffort: input.variant } : {}),
					...(input.fast ? { fast: true } : {}),
					...(session?.taskAccess === "read_only" ? { readOnly: true } : {}),
				});
			}
			return yield* Effect.tryPromise(() =>
				persistBoundSessionView(session, {
					...viewFromClaude(status, providerRef),
					listedModelId,
				}),
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
		let listedModelId = "";
		if (status.stage === "authenticated") {
			const preference = listedModelPreferenceFromSessions({
				harness: session?.harness ?? scope.harnessId,
				sessions: session
					? [
							{
								harness: session.harness,
								listedModelId: session.listedModelId,
								items: session.items,
							},
						]
					: [],
			});
			listedModelId = modelIdToSubmit(input.modelId, status.models, {
				lastUsedId: preference.listedModelId,
				excludedIds: preference.blockedListedModelIds,
			});
			if (!listedModelId) {
				return yield* Effect.tryPromise(() =>
					persistBoundSessionView(session, {
						...viewFromOpenCode(status, providerRef),
						connection: {
							status: "failed",
							provider: "opencode",
							message: "OpenCode did not list a model to run.",
						},
					}),
				);
			}
			yield* Effect.tryPromise(() =>
				persistSessionTurnStatus(session, "running"),
			);
			const listed = status.models.find((model) => model.id === listedModelId);
			const listedFast = listedFastModeId(listed ?? {});
			const listedVariant =
				input.variant?.trim() &&
				listed?.reasoning?.levels.some(
					(level) => level.id === input.variant?.trim(),
				)
					? input.variant.trim()
					: undefined;
			status = yield* submitOpenCodeTask(machines, WorkspaceId(providerRef), {
				...payload,
				modelId: listedModelId,
				variant: input.fast && listedFast ? listedFast : listedVariant,
			});
		}
		return yield* Effect.tryPromise(() =>
			persistBoundSessionView(session, {
				...viewFromOpenCode(status, providerRef),
				listedModelId,
			}),
		);
	});
}

/**
 * Side chat is a second agent session VM copied from the same project
 * snapshot. Codex uses that copy's main lane so it does not share the
 * parent's checkout. Read of the parent stays paused-safe.
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
			sideAgentSession(scope.userId, scope.sessionId as string),
		);
		const bound = yield* Effect.tryPromise(() =>
			bindAgentSessionMachine(machines, {
				userId: scope.userId,
				projectId: scope.projectId as string,
				harness: scope.harnessId,
				sessionId: existing?.id,
				createNew: !existing,
				parentSessionId: scope.sessionId,
				title: "Side chat",
			}),
		);
		yield* Effect.tryPromise(() =>
			machines.ensureRunning(WorkspaceId(bound.providerRef)),
		);
		yield* Effect.tryPromise(() =>
			persistSessionTurnStatus(bound.session, "running"),
		);
		const sideView =
			scope.harnessId === "codex"
				? yield* sendCodexWorkspaceTask(
						machines,
						{
							userId: scope.userId,
							projectId: scope.projectId,
							sessionId: bound.session.id,
							createNew: false,
						},
						{
							text: input.text,
							modelId: input.modelId,
						},
					)
				: yield* submitConnectedHarnessTask(
						machines,
						scope,
						bound.providerRef,
						bound.session,
						input,
					);
		const main = yield* readHarnessWorkspaceSession(machines, {
			...scope,
			createNew: false,
		});
		return mergeSideChat(main, sideView, scope.harnessId);
	}).pipe(
		Effect.catchAll((cause) =>
			Effect.succeed({
				...emptyHarnessSession(),
				connection: {
					status: "failed" as const,
					provider: scope.harnessId,
					message: publicFailureMessage(cause),
				},
			}),
		),
	);
}

/**
 * Side Stop targets the child session VM. It does not copy a new machine
 * and does not abort the parent's running turn.
 */
function stopHarnessSideTurn(
	machines: WorkspaceMachines,
	scope: HarnessSessionScope,
): Effect.Effect<PublicHarnessSession> {
	return Effect.gen(function* () {
		if (!scope.projectId || !scope.sessionId) {
			return {
				...emptyHarnessSession(),
				connection: {
					status: "failed" as const,
					provider: scope.harnessId,
					message: "Open a chat before stopping a side agent.",
				},
			};
		}
		const child = yield* Effect.tryPromise(() =>
			sideAgentSession(scope.userId, scope.sessionId as string),
		);
		if (!child) {
			return yield* readHarnessWorkspaceSession(machines, scope);
		}
		const stopped = yield* stopHarnessWorkspaceTurn(machines, {
			userId: scope.userId,
			projectId: scope.projectId,
			sessionId: child.id,
			harnessId: child.harness,
			createNew: false,
		});
		const main = yield* readHarnessWorkspaceSession(machines, {
			...scope,
			createNew: false,
		});
		return mergeSideChat(main, stopped, scope.harnessId);
	}).pipe(
		Effect.catchAll((cause) =>
			Effect.succeed({
				...emptyHarnessSession(),
				connection: {
					status: "failed" as const,
					provider: scope.harnessId,
					message: publicFailureMessage(cause),
				},
			}),
		),
	);
}

function withSiblingSideChat(
	machines: WorkspaceMachines,
	scope: HarnessSessionScope,
	view: Effect.Effect<PublicHarnessSession>,
): Effect.Effect<PublicHarnessSession> {
	return view.pipe(
		Effect.flatMap((session) =>
			attachSiblingSideChat(machines, scope, session),
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
			sideAgentSession(scope.userId, scope.sessionId as string),
		);
		if (!child?.providerRef) {
			return mergeSideChat(main, null, scope.harnessId);
		}
		if (scope.harnessId === "codex") {
			const side = yield* readCodexWorkspaceSession(machines, {
				userId: scope.userId,
				projectId: scope.projectId,
				sessionId: child.id,
			});
			return mergeSideChat(main, side, scope.harnessId);
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
	session: { readonly listedModelId?: string | null } | null,
): PublicHarnessSession {
	const listedModelId = session?.listedModelId?.trim() ?? "";
	if (
		scope.harnessId === "claude" &&
		claudeSessionRemembersSignIn(listedModelId)
	) {
		const models = rememberedClaudeModels(listedModelId);
		return {
			...emptyHarnessSession(),
			workspaceId,
			connection: {
				status: "authenticated",
				provider: "claude",
				authMode: "subscription",
				planType: null,
				email: null,
			},
			models,
			listedModelId,
			canSend: true,
			canSendSide: true,
		};
	}
	const view = emptyHarnessSession();
	const listedModels = listedModelId
		? [
				{
					id: listedModelId,
					label: listedModelDisplayName(listedModelId) || listedModelId,
				},
			]
		: [];
	return {
		...view,
		workspaceId,
		models: listedModels,
		listedModelId,
		canSend: canResumeDisconnectedFollowUp({
			harnessId: scope.harnessId,
			connection: view.connection,
			turnStatus: "idle",
			snapshotAvailable: view.snapshotAvailable,
			listedModelId,
		}),
		canSendSide: canResumeDisconnectedFollowUp({
			harnessId: scope.harnessId,
			connection: view.connection,
			turnStatus: "idle",
			snapshotAvailable: view.snapshotAvailable,
			listedModelId,
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

function rememberClaudeHome(
	machines: WorkspaceMachines,
	workspaceId: WorkspaceId,
	userId: string,
	status: ClaudeAuthStatus,
	snapshot: "ensure" | "replace" | false = "ensure",
): Effect.Effect<void> {
	if (status.stage !== "authenticated") return Effect.void;
	return Effect.gen(function* () {
		yield* captureClaudeHome(machines, workspaceId, userId);
		if (!snapshot) return;
		const persist =
			snapshot === "replace"
				? refreshClaudeAuthSnapshotForUser
				: persistClaudeAuthSnapshotForUser;
		yield* persist(userId, machines, workspaceId, {
			planType: status.planType,
			email: null,
		});
	});
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
