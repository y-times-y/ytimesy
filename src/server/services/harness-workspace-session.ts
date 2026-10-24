import { Effect } from "effect";
import type { AgentProviderId } from "#/domain/agent-provider";
import { runtimeHandoffPrompt } from "#/domain/api-conversation";
import type {
	IncomingAttachment,
	MessageAttachment,
} from "#/domain/message-attachment";
import { publicFailureMessage } from "#/domain/project-workspace";
import { sessionItemsFromUnknown } from "#/domain/session-item";
import {
	type AgentSessionRecord,
	agentSessionForOwner,
	claimChatForSend,
	releaseChatClaim,
	releasingChatClaimOnFailure,
	saveAgentTaskState,
	selectAgentSessionHarness,
} from "#/server/adapters/agent-sessions";
import { warmCodexSubscriptionCatalog } from "../adapters/codex-subscription";
import { prepareAgentTaskStart } from "./agent-session-machine";
import {
	readApiWorkspaceSession,
	sendApiWorkspaceTask,
	stopApiWorkspaceTask,
} from "./api-workspace-session";
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
import { commitChatBranchForSubmission } from "./session-branch";
import { timed } from "./step-timing";
import type { WorkspaceMachines } from "./workspace-machines";

export type HarnessSessionScope = CodexSessionScope & {
	readonly harnessId: AgentProviderId;
};

type PublicHarnessSession = PublicCodexSession;

/** Starts a subagent row that subagent-tools opened (docs/subagents.md). */
export function startPreparedAgentTask(
	scope: HarnessSessionScope,
	taskSessionId: string,
	/** The first turn's reasoning effort (a role model's); the route default when unset. */
	options?: { readonly reasoning?: string },
): Effect.Effect<{ id: string; machineId: string | null }, unknown> {
	return Effect.gen(function* () {
		if (!scope.projectId) throw new Error("The project is not available.");
		const { task } = yield* Effect.tryPromise(() =>
			prepareAgentTaskStart({
				userId: scope.userId,
				projectId: scope.projectId as string,
				taskSessionId,
			}),
		);
		if (!task.taskPrompt || !task.listedModelId)
			throw new Error("The subagent is missing its brief or model.");
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
		return { id: task.id, machineId: task.providerRef };
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
	/** The chat as the caller just read it (by id, for this user), saving a read. */
	known?: AgentSessionRecord | null,
): Effect.Effect<PublicHarnessSession> {
	if (
		scope.harnessId !== "api" &&
		input.runtimeText === undefined &&
		scope.sessionId
	) {
		let claimed = false;
		// The plan's model catalog (a ChatGPT request, often uncached on a new
		// Worker isolate) loads beside the claim and branch commit; the view
		// below awaits the same load.
		warmCodexSubscriptionCatalog(scope.userId);
		return Effect.gen(function* () {
			const previous =
				known?.id === scope.sessionId
					? known
					: yield* Effect.tryPromise(() =>
							timed("send:chat", () =>
								agentSessionForOwner(scope.userId, scope.sessionId as string),
							),
						);
			const switching = previous && previous.harness !== scope.harnessId;
			if (switching && previous.turnStatus === "running")
				throw new Error("Stop the active turn before switching runtimes.");
			// Claimed before the commit and file uploads, so New chat can't reuse it.
			claimed = yield* Effect.tryPromise(() =>
				timed("send:claim", () =>
					claimChatForSend(scope.userId, scope.sessionId as string, input.text),
				),
			);
			// The chat as read above (the claim only titled it), then as each
			// write below leaves it: the send reads it no further.
			let current = previous;
			if (scope.projectId)
				current = yield* Effect.tryPromise(() =>
					timed("send:branch", () =>
						commitChatBranchForSubmission({
							userId: scope.userId,
							projectId: scope.projectId as string,
							sessionId: scope.sessionId as string,
							text: input.text,
							session: previous,
						}),
					),
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
				current = yield* Effect.tryPromise(() =>
					selectAgentSessionHarness(
						scope.userId,
						previous.projectId,
						previous.id,
						scope.harnessId,
					),
				);
			const read = current ?? undefined;
			return yield* Effect.promise(() =>
				sendSubscriptionTask(
					scope,
					{
						...input,
						runtimeText: input.text,
						...(runtimeHandoff ? { runtimeHandoff } : {}),
					},
					false,
					read,
				),
			);
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
			// The send continues from the chat the branch commit read (or wrote).
			const send = async () =>
				sendApiWorkspaceTask(
					scope,
					input,
					false,
					scope.projectId
						? await commitChatBranchForSubmission({
								userId: scope.userId,
								projectId: scope.projectId,
								sessionId,
								text: input.text,
							})
						: undefined,
				);
			return (await claimChatForSend(scope.userId, sessionId, input.text))
				? releasingChatClaimOnFailure(scope.userId, sessionId, input.text, send)
				: send();
		});
	return Effect.promise(() => sendSubscriptionTask(scope, input));
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
