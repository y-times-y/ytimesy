import { Effect } from "effect";
import { z } from "zod";
import type { AgentProviderId } from "#/domain/agent-provider";
import {
	agentTaskStatusReceipt,
	agentTaskSummaryPage,
	agentTaskTree,
	taskExecutionCapabilities,
} from "#/domain/agent-task";
import {
	type AgentTaskToolRequest,
	taskBriefTooLong,
	taskToolAccess,
	taskToolExecution,
	taskToolHarness,
	taskToolPlacement,
	taskToolString,
} from "#/domain/agent-task-tool";
import { runtimeHandoffPrompt } from "#/domain/api-conversation";
import { WorkspaceId } from "#/domain/ids";
import type {
	IncomingAttachment,
	MessageAttachment,
} from "#/domain/message-attachment";
import { publicFailureMessage } from "#/domain/project-workspace";
import {
	lastAgentMessageText,
	sessionItemsFromUnknown,
} from "#/domain/session-item";
import {
	taskCheckJournalIds,
	taskHandoffReferences,
} from "#/domain/task-handoff";
import {
	type AgentSessionRecord,
	agentSessionForOwner,
	claimChatForSend,
	descendantAgentSessions,
	releaseChatClaim,
	releasingChatClaimOnFailure,
	saveAgentTaskPublication,
	saveAgentTaskReview,
	saveAgentTaskState,
	selectAgentSessionHarness,
} from "#/server/adapters/agent-sessions";
import { retainedTaskCheckResults } from "#/server/adapters/agent-task-command-receipts";
import { saveAgentTaskBlockedEvent } from "#/server/adapters/agent-task-events";
import { hasActiveApiTurn } from "#/server/adapters/api-turns";
import { PROJECT_CWD_PATH } from "#/server/adapters/freestyle/clone-project";
import { acceptTaskPatch } from "#/server/adapters/task-patch-evidence";
import { findCompletedVerification } from "#/server/adapters/turn-verification";
import { enqueueAgentTaskEvent } from "#/server/jobs/queue";
import { agentCapacity } from "../adapters/agent-capacity";
import {
	discoverAgentPeers,
	queueAgentPeerMessage,
} from "./agent-peer-messaging";
import {
	editAgentTaskDraft,
	openAgentTask,
	prepareAgentTaskStart,
} from "./agent-session-machine";
import {
	readApiWorkspaceSession,
	sendApiWorkspaceTask,
	stopApiWorkspaceTask,
} from "./api-workspace-session";
import { awaitStoppedTurn } from "./await-stopped-turn";
import {
	connectSubscriptionSession,
	readSubscriptionLoginSession,
	sendSubscriptionTask,
	stopSubscriptionTask,
} from "./codex-subscription-session";
import {
	type CodexSessionScope,
	emptyCodexSession,
	type PublicCodexSession,
} from "./codex-workspace-session";
import { publishProject } from "./publication";
import {
	captureTaskPatch,
	importReviewedTaskChanges,
	taskPatchPreview,
} from "./reviewed-task-import";
import { commitChatBranchForSubmission } from "./session-branch";
import { machinesForAgentSession } from "./session-workspace-machines";
import type { WorkspaceMachines } from "./workspace-machines";

export type HarnessSessionScope = CodexSessionScope & {
	readonly harnessId: AgentProviderId;
};

type PublicHarnessSession = PublicCodexSession;

export function startPreparedAgentTask(
	scope: HarnessSessionScope,
	taskSessionId: string,
	expectedDraft?: AgentSessionRecord,
	/** The first turn's reasoning effort (a role model's); the route default when unset. */
	options?: { readonly reasoning?: string },
): Effect.Effect<
	{ id: string; machineId: string | null; placement: "shared" | "fresh" },
	unknown
> {
	return Effect.gen(function* () {
		if (!scope.projectId) throw new Error("The project is not available.");
		const { task } = yield* Effect.tryPromise(() =>
			prepareAgentTaskStart({
				userId: scope.userId,
				projectId: scope.projectId as string,
				taskSessionId,
				expectedDraft,
			}),
		);
		if (!task.taskPrompt || !task.listedModelId || !task.taskPlacement) {
			throw new Error(
				"The task draft is missing its prompt, model, or placement.",
			);
		}
		const send =
			task.harness === "api" ? sendApiWorkspaceTask : sendSubscriptionTask;
		yield* Effect.tryPromise(() =>
			send(
				taskScope(scope, task),
				{
					text: task.taskPrompt as string,
					modelId: task.listedModelId as string,
					...(options?.reasoning ? { variant: options.reasoning } : {}),
				},
				true,
			),
		).pipe(
			Effect.tapError(() =>
				Effect.tryPromise(() => saveAgentTaskState(task.id, "failed")),
			),
		);
		return {
			id: task.id,
			machineId: task.providerRef,
			placement: task.taskPlacement as "shared" | "fresh",
		};
	});
}

function requestAgentTaskWrapUp(
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
		const selectedModel = modelId || task.listedModelId;
		if (!selectedModel) throw new Error("The task has no model selection.");
		const taskMachines = machinesForAgentSession(machines, task);
		const targetScope = taskScope(scope, task);
		yield* stopHarnessWorkspaceTurn(targetScope);
		yield* Effect.tryPromise(() =>
			awaitStoppedTurn(
				async () =>
					(await agentSessionForOwner(scope.userId, task.id))?.turnStatus,
			),
		);
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

/** The stored transcript and connection; reading never starts a VM. */
export function readHarnessWorkspaceSession(
	scope: HarnessSessionScope,
): Effect.Effect<PublicHarnessSession> {
	return Effect.promise(() =>
		scope.harnessId === "codex"
			? readSubscriptionLoginSession(scope)
			: readApiWorkspaceSession(scope),
	);
}

/** Connect: API models read their connection; Codex starts a ChatGPT sign-in when needed. */
export function connectHarnessWorkspaceSession(
	scope: HarnessSessionScope,
): Effect.Effect<PublicHarnessSession> {
	return Effect.promise(() =>
		scope.harnessId === "api"
			? readApiWorkspaceSession(scope)
			: connectSubscriptionSession(scope),
	);
}

/** `_machines` is unused; it stays so the evaluation harness's call shape is unchanged. */
export function sendHarnessWorkspaceTask(
	_machines: WorkspaceMachines,
	scope: HarnessSessionScope,
	input: {
		readonly text: string;
		readonly modelId: string;
		readonly variant?: string;
		readonly fast?: boolean;
		/** API-key models only; Codex uses `fast`. */
		readonly speed?: "standard" | "fast" | "ultrafast";
		readonly runtimeText?: string;
		/** A runtime-switch envelope, used only when no structured history carries over. */
		readonly runtimeHandoff?: string;
		readonly idempotencyKey?: string;
		readonly approvesPlan?: boolean;
		readonly attachments?: readonly IncomingAttachment[];
		/** Files a queued message already put in private storage. */
		readonly storedAttachments?: readonly MessageAttachment[];
		/** Continue this turn on a fallback route the user approved (`<connection>|<model>`). */
		readonly continueOn?: string;
	},
): Effect.Effect<PublicHarnessSession> {
	if (
		scope.harnessId !== "api" &&
		input.runtimeText === undefined &&
		scope.sessionId
	) {
		let claimed = false;
		return Effect.gen(function* () {
			const previous = yield* Effect.tryPromise(() =>
				agentSessionForOwner(scope.userId, scope.sessionId as string),
			);
			const switching = previous && previous.harness !== scope.harnessId;
			if (switching && previous.turnStatus === "running")
				throw new Error("Stop the active turn before switching runtimes.");
			// Claimed before the commit and file uploads, so New chat can't reuse it.
			claimed = yield* Effect.tryPromise(() =>
				claimChatForSend(scope.userId, scope.sessionId as string, input.text),
			);
			if (scope.projectId)
				yield* Effect.tryPromise(() =>
					commitChatBranchForSubmission({
						userId: scope.userId,
						projectId: scope.projectId as string,
						sessionId: scope.sessionId as string,
						text: input.text,
					}),
				);
			// The envelope repeats the transcript; the send uses it only when the
			// last turn left no structured history to continue from.
			const runtimeHandoff = switching
				? runtimeHandoffPrompt(
						sessionItemsFromUnknown(previous.items),
						input.text,
					)
				: undefined;
			if (switching)
				yield* Effect.tryPromise(() =>
					selectAgentSessionHarness(
						scope.userId,
						previous.projectId,
						previous.id,
						scope.harnessId,
					),
				);
			return yield* sendHarnessWorkspaceTask(_machines, scope, {
				...input,
				runtimeText: input.text,
				...(runtimeHandoff ? { runtimeHandoff } : {}),
			});
		}).pipe(
			// A rejected first send hands its chat back for New chat to reuse.
			Effect.tapErrorCause(() =>
				claimed
					? Effect.promise(() =>
							releaseChatClaim(
								scope.userId,
								scope.sessionId as string,
								input.text,
							).catch(() => undefined),
						)
					: Effect.void,
			),
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
	if (scope.harnessId === "api")
		return Effect.promise(async () => {
			const sessionId = scope.sessionId;
			if (!sessionId) return sendApiWorkspaceTask(scope, input);
			const send = async () => {
				if (scope.projectId)
					await commitChatBranchForSubmission({
						userId: scope.userId,
						projectId: scope.projectId,
						sessionId,
						text: input.text,
					});
				return sendApiWorkspaceTask(scope, input);
			};
			return (await claimChatForSend(scope.userId, sessionId, input.text))
				? releasingChatClaimOnFailure(scope.userId, sessionId, input.text, send)
				: send();
		});
	return Effect.promise(() => sendSubscriptionTask(scope, input));
}

export function runAgentTaskTool(
	machines: WorkspaceMachines,
	scope: HarnessSessionScope,
	parent: AgentSessionRecord,
	request: AgentTaskToolRequest,
	control?: { signal: AbortSignal; turnId: string },
): Effect.Effect<unknown, unknown> {
	return Effect.gen(function* () {
		if (!scope.projectId) throw new Error("The project is not available.");
		if (
			request.tool === "publish_task" &&
			process.env.YTIMESY_HARNESS_EVALUATION_ENABLED === "1"
		) {
			const { evaluationRunForTask } = yield* Effect.tryPromise(
				() => import("../adapters/harness-evaluation"),
			);
			if (
				yield* Effect.tryPromise(() =>
					evaluationRunForTask(scope.userId, parent.id),
				)
			)
				throw new Error(
					"Evaluation runs cannot publish branches or pull requests.",
				);
		}
		if (parent.userId !== scope.userId || parent.projectId !== scope.projectId)
			throw new Error("The agent is not available in this project.");
		if (request.tool === "read_task_capacity")
			return yield* Effect.tryPromise(() => agentCapacity(scope.userId));
		if (request.tool === "list_peers") {
			const peers = yield* Effect.tryPromise(() => discoverAgentPeers(parent));
			return peers.map((task) => ({
				taskId: task.id,
				title: task.title,
				objective: task.taskPrompt,
				status: task.taskState,
				turnStatus: task.turnStatus,
				access: task.taskAccess,
				modelId: task.listedModelId,
			}));
		}
		if (request.tool === "send_peer_message")
			return yield* Effect.tryPromise(() =>
				queueAgentPeerMessage(
					parent,
					taskToolString(request.arguments, "taskId"),
					taskToolString(request.arguments, "message"),
					request.id,
				),
			);
		if (request.tool === "create_task") {
			const startImmediately = request.arguments.startImmediately;
			if (
				startImmediately !== undefined &&
				typeof startImmediately !== "boolean"
			)
				throw new Error("startImmediately must be a boolean.");
			const title = taskToolString(request.arguments, "title");
			const prompt = taskToolString(request.arguments, "prompt");
			if (!title || !prompt)
				throw new Error("Task title and prompt are required.");
			const briefTooLong = taskBriefTooLong(prompt);
			if (briefTooLong) throw new Error(briefTooLong);
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
			const draft = {
				taskId: task.id,
				title: task.title,
				status: "draft",
				placement: task.taskPlacement,
				execution: task.taskExecution,
				capabilities: taskExecutionCapabilities(task),
			};
			if (!startImmediately) return draft;
			return yield* startPreparedAgentTask(scope, task.id).pipe(
				Effect.map((started) => ({
					...draft,
					status: "working",
					machineId: started.machineId,
				})),
				Effect.catchAll(() =>
					Effect.tryPromise(() =>
						agentSessionForOwner(scope.userId, task.id),
					).pipe(
						Effect.catchAll(() => Effect.succeed(null)),
						Effect.map((current) => ({
							...draft,
							status: current?.taskState ?? "unknown",
							startError:
								"Task ID retained. Start was not confirmed; inspect capacity and task state before retrying this same task. Do not create a replacement.",
						})),
					),
				),
			);
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

		if (request.tool === "import_reviewed_task") {
			return yield* Effect.tryPromise(() =>
				importReviewedTaskChanges(
					machines,
					parent,
					taskToolString(request.arguments, "taskId"),
					taskToolString(request.arguments, "expectedSha256"),
				),
			);
		}
		const descendants = yield* Effect.tryPromise(() =>
			descendantAgentSessions(scope.userId, parent.id),
		);
		const taskRows = descendants;
		if (request.tool === "list_tasks") {
			const byId = new Map(taskRows.map((row) => [row.id, row]));
			return agentTaskTree(parent.id, taskRows).map((task) => {
				const row = byId.get(task.id);
				if (!row)
					throw new Error("Task tree references an unavailable session.");
				return {
					...agentTaskStatusReceipt(
						task,
						request.arguments.includePrompts === true,
					),
					capabilities: taskExecutionCapabilities(row),
					summary:
						task.summary ??
						lastAgentMessageText(sessionItemsFromUnknown(row.items)),
				};
			});
		}

		const taskId = taskToolString(request.arguments, "taskId");
		const target = taskRows.find((row) => row.id === taskId);
		if (!target) throw new Error("That descendant task is not available.");
		if (request.tool === "read_task_handoff") {
			if (
				target.userId !== scope.userId ||
				target.projectId !== scope.projectId
			)
				throw new Error("The task handoff is not available in this project.");
			if (target.taskState !== "done" || target.turnStatus === "running")
				throw new Error("Only a completed task has a review handoff.");
			if (!target.providerRef)
				throw new Error("The task has no machine to inspect.");
			const start = z
				.number()
				.int()
				.min(0)
				.max(8_388_608)
				.parse(request.arguments.start ?? 0);
			const items = sessionItemsFromUnknown(target.items);
			const checkCalls = taskCheckJournalIds(items);
			const retained = yield* Effect.tryPromise(() =>
				retainedTaskCheckResults({
					userId: scope.userId,
					projectId: scope.projectId as string,
					sessionId: target.id,
					requestIds: checkCalls.slice(-64),
				}),
			);
			const discovered = taskHandoffReferences(items, retained);
			const references =
				request.arguments.references === undefined
					? discovered.references.slice(0, 8)
					: z.array(z.uuid()).min(1).max(8).parse(request.arguments.references);
			const taskMachines = machinesForAgentSession(machines, target);
			const signal = control?.signal ?? AbortSignal.timeout(20000);
			yield* Effect.tryPromise(() =>
				taskMachines.ensureRunning(WorkspaceId(target.providerRef as string)),
			);
			const { readAuthorizedTaskChecks } = yield* Effect.tryPromise(
				() => import("./task-output-evidence"),
			);
			const [patch, checks] = yield* Effect.tryPromise(() =>
				Promise.all([
					captureTaskPatch(
						taskMachines,
						WorkspaceId(target.providerRef as string),
					),
					references.length
						? readAuthorizedTaskChecks({
								machines: taskMachines,
								task: target,
								ownerId: scope.userId,
								projectId: scope.projectId as string,
								references,
								signal,
							})
						: Promise.resolve(null),
				]),
			);
			const cwd = yield* Effect.tryPromise(() =>
				taskMachines.readTextFile(
					WorkspaceId(target.providerRef as string),
					PROJECT_CWD_PATH,
				),
			);
			const completionVerification = cwd?.trim()
				? yield* Effect.tryPromise(() =>
						findCompletedVerification(scope.userId, target.id, cwd.trim(), {
							base: patch.base,
							patchSha256: patch.sha256,
						}),
					)
				: null;
			return {
				taskId: target.id,
				diff: taskPatchPreview(patch, start),
				completionVerification,
				summary: agentTaskSummaryPage(
					lastAgentMessageText(sessionItemsFromUnknown(target.items)) ??
						target.taskSummary,
				),
				checks,
				verificationReferences: references,
				remainingReferences: discovered.references.filter(
					(reference) => !references.includes(reference),
				),
				failedAttemptReferences: discovered.failedReferences.slice(-8),
				failedAttemptsOmitted: Math.max(
					0,
					discovered.failedReferences.length - 8,
				),
				discoveryIncomplete: discovered.incomplete || checkCalls.length > 64,
				instruction:
					"Check every required command and owned source against the original contract. Missing, incomplete or stale evidence is not success; retrieve retained outputs without waking the builder. Follow remaining references and diff/summary cursors before acceptance.",
			};
		}
		if (request.tool === "read_task_summary") {
			if (
				target.userId !== scope.userId ||
				target.projectId !== scope.projectId
			)
				throw new Error("The task summary is not available in this project.");
			return {
				taskId: target.id,
				state: target.taskState,
				capabilities: taskExecutionCapabilities(target),
				...agentTaskSummaryPage(
					lastAgentMessageText(sessionItemsFromUnknown(target.items)) ??
						target.taskSummary,
					request.arguments.start,
				),
			};
		}
		if (request.tool === "read_task_checks") {
			const { readAuthorizedTaskChecks } = yield* Effect.tryPromise(
				() => import("./task-output-evidence"),
			);
			return yield* Effect.tryPromise(() =>
				readAuthorizedTaskChecks({
					machines: machinesForAgentSession(machines, target),
					task: target,
					ownerId: scope.userId,
					projectId: scope.projectId as string,
					references: request.arguments.references,
					signal: control?.signal ?? AbortSignal.timeout(20000),
				}),
			);
		}
		if (request.tool === "read_task_output") {
			const { readAuthorizedTaskOutput } = yield* Effect.tryPromise(
				() => import("./task-output-evidence"),
			);
			return yield* Effect.tryPromise(() =>
				readAuthorizedTaskOutput({
					machines: machinesForAgentSession(machines, target),
					task: target,
					ownerId: scope.userId,
					projectId: scope.projectId as string,
					page: request.arguments,
					signal: control?.signal ?? AbortSignal.timeout(20000),
				}),
			);
		}
		if (request.tool === "edit_task") {
			const title = taskToolString(request.arguments, "title");
			const prompt = taskToolString(request.arguments, "prompt");
			const briefTooLong = prompt ? taskBriefTooLong(prompt) : null;
			if (briefTooLong) throw new Error(briefTooLong);
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
			const started = yield* startPreparedAgentTask(scope, target.id);
			return {
				taskId: started.id,
				status: "working",
				placement: started.placement,
				machineId: started.machineId,
			};
		}
		if (request.tool === "inspect_task_diff") {
			const start = request.arguments.start ?? 0;
			if (
				typeof start !== "number" ||
				!Number.isSafeInteger(start) ||
				start < 0 ||
				start > 8_388_608
			)
				throw new Error("Choose a valid bounded diff offset.");
			if (!target.providerRef) {
				throw new Error("The task has no machine to inspect.");
			}
			yield* Effect.tryPromise(() =>
				machines.ensureRunning(WorkspaceId(target.providerRef as string)),
			);
			const patch = yield* Effect.tryPromise(() =>
				captureTaskPatch(
					machinesForAgentSession(machines, target),
					WorkspaceId(target.providerRef as string),
				),
			);
			const cwd = yield* Effect.tryPromise(() =>
				machinesForAgentSession(machines, target).readTextFile(
					WorkspaceId(target.providerRef as string),
					PROJECT_CWD_PATH,
				),
			);
			const completionVerification = cwd?.trim()
				? yield* Effect.tryPromise(() =>
						findCompletedVerification(scope.userId, target.id, cwd.trim(), {
							base: patch.base,
							patchSha256: patch.sha256,
						}),
					)
				: null;
			return {
				taskId: target.id,
				...taskPatchPreview(patch, start),
				completionVerification,
			};
		}
		if (request.tool === "mark_task_reviewed") {
			if (target.taskState !== "done") {
				throw new Error("Only a completed task can be marked reviewed.");
			}
			if (target.taskAccess !== "read_write") {
				const reviewed = yield* Effect.tryPromise(() =>
					saveAgentTaskReview(target.id, "reviewed"),
				);
				if (!reviewed) throw new Error("The task review could not be saved.");
				return { taskId: target.id, reviewState: "reviewed" };
			}
			if (!target.providerRef || !target.parentSessionId)
				throw new Error("Writable review workspace is unavailable.");
			if (request.arguments.verificationReferences !== undefined) {
				const references = z
					.array(z.uuid())
					.min(1)
					.max(8)
					.parse(request.arguments.verificationReferences);
				const { readAuthorizedTaskChecks, requireCurrentTaskCheck } =
					yield* Effect.tryPromise(() => import("./task-output-evidence"));
				const bundle = yield* Effect.tryPromise(() =>
					readAuthorizedTaskChecks({
						machines: machinesForAgentSession(machines, target),
						task: target,
						ownerId: scope.userId,
						projectId: scope.projectId as string,
						references,
						signal: control?.signal ?? AbortSignal.timeout(20000),
					}),
				);
				for (const check of bundle.checks) {
					const proof =
						check.sourceProof === null
							? null
							: bundle.sourceProofs[check.sourceProof];
					requireCurrentTaskCheck({
						completion: check.completion,
						verification: proof,
						sourcesCurrent: proof?.sourcesCurrent,
					});
				}
			}
			const expectedSha256 = taskToolString(
				request.arguments,
				"expectedSha256",
			);
			if (!/^[a-f0-9]{64}$/.test(expectedSha256))
				throw new Error(
					"Provide the exact patch hash from the inspected diff receipt.",
				);
			const patch = yield* Effect.tryPromise(() =>
				captureTaskPatch(
					machinesForAgentSession(machines, target),
					WorkspaceId(target.providerRef as string),
				),
			);
			if (patch.sha256 !== expectedSha256)
				throw new Error(
					"Task changed after inspection; inspect its exact diff again before accepting.",
				);
			yield* Effect.tryPromise(() =>
				acceptTaskPatch(scope.userId, target.parentSessionId as string, {
					taskId: target.id,
					sha256: patch.sha256,
					base: patch.base,
				}),
			);
			return {
				taskId: target.id,
				reviewState: "reviewed",
				sha256: patch.sha256,
				base: patch.base,
			};
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
				repositoryFullName:
					taskToolString(request.arguments, "repositoryFullName") || undefined,
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
		const message = taskToolString(request.arguments, "message");
		if (!message) throw new Error("A task message is required.");
		const requiresCommands = z
			.boolean()
			.parse(request.arguments.requiresCommandExecution ?? false);
		const resumeCompleted = z
			.boolean()
			.parse(request.arguments.resumeCompleted ?? false);
		const capabilities = taskExecutionCapabilities(target);
		if (requiresCommands && !capabilities.commandExecution)
			throw new Error(
				"This read-only task cannot execute commands. Use an authorized isolated verification task; do not wake this child to run tests.",
			);
		if (
			target.taskState === "done" &&
			target.turnStatus !== "running" &&
			!resumeCompleted
		)
			return {
				taskId: target.id,
				status: "completed",
				delivered: false,
				capabilities,
				...agentTaskSummaryPage(
					lastAgentMessageText(sessionItemsFromUnknown(target.items)) ??
						target.taskSummary,
				),
				instruction:
					"The child is already complete; no message was delivered and no turn started. Follow read_task_summary cursors for its full result. Set resumeCompleted:true only for genuinely new authorized work.",
			};
		if (
			target.turnStatus === "running" ||
			((target.harness === "api" || target.harness === "codex") &&
				(yield* Effect.tryPromise(() =>
					hasActiveApiTurn(target.userId, target.id),
				)))
		)
			return yield* Effect.tryPromise(() =>
				queueAgentPeerMessage(parent, target.id, message, request.id),
			);
		const modelId = target.listedModelId || parent.listedModelId || "";
		if (!modelId) throw new Error("The task has no model selection.");
		const targetMachines = machinesForAgentSession(machines, target);
		const sent = yield* sendHarnessWorkspaceTask(
			targetMachines,
			taskScope(scope, target),
			{
				text: message,
				modelId,
			},
		);
		if (sent.connection.status === "failed")
			throw new Error(
				sent.connection.message ?? "The child follow-up could not start.",
			);
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

export function stopHarnessWorkspaceTurn(
	scope: HarnessSessionScope,
): Effect.Effect<PublicHarnessSession> {
	return Effect.promise(() =>
		scope.harnessId === "api"
			? stopApiWorkspaceTask(scope)
			: stopSubscriptionTask(scope),
	);
}
