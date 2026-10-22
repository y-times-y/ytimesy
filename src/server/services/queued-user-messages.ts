import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import type { MessageAttachment } from "#/domain/message-attachment";
import { withAttachmentNote } from "#/domain/message-attachment";
import type { UserMessageItem } from "#/domain/session-item";
import {
	sendWasQueued,
	sessionItemsFromUnknown,
	sessionItemsQueuedWithUser,
	withQueuedUserMessages,
} from "#/domain/session-item";
import {
	type AgentSessionRecord,
	agentSessionForOwner,
} from "../adapters/agent-sessions";
import {
	queuedUserMessageItems,
	queueUserMessageWhileRunning,
	removeQueuedUserMessage,
	restoreQueuedUserMessage,
	takeNextQueuedUserMessage,
} from "../adapters/queued-user-messages";
import { mentionNoteFor } from "./agent-mentions";
import type { PublicCodexSession } from "./codex-workspace-session";
import {
	type HarnessSessionScope,
	readHarnessWorkspaceSession,
	sendHarnessWorkspaceTask,
	stopHarnessWorkspaceTurn,
} from "./harness-workspace-session";
import { storeMessageAttachments } from "./message-attachments";
import { timed } from "./step-timing";
import type { WorkspaceMachines } from "./workspace-machines";

type ComposerSend = Parameters<typeof sendHarnessWorkspaceTask>[2];

/**
 * The person's own send: while the chat's turn runs it waits for that turn's
 * next model step; otherwise it starts a turn. Runtime sends (notices, plan
 * approvals, fallback continuations) never queue.
 */
export function sendComposerMessage(
	machines: WorkspaceMachines,
	scope: HarnessSessionScope,
	input: ComposerSend,
): Effect.Effect<PublicCodexSession> {
	return Effect.flatMap(
		Effect.promise(() =>
			timed("send:queueCheck", () => queueBehindRunningTurn(scope, input)),
		),
		(queued) =>
			"view" in queued
				? Effect.succeed(queued.view)
				: sendHarnessWorkspaceTask(
						machines,
						scope,
						{
							...input,
							...(queued.storedAttachments
								? {
										attachments: undefined,
										storedAttachments: queued.storedAttachments,
									}
								: {}),
						},
						queued.session,
					),
	);
}

async function queueBehindRunningTurn(
	scope: HarnessSessionScope,
	input: ComposerSend,
): Promise<
	| { view: PublicCodexSession }
	| {
			storedAttachments?: readonly MessageAttachment[];
			/** The chat as read here; the send that follows need not read it again. */
			session?: AgentSessionRecord | null;
	  }
> {
	if (
		!scope.sessionId ||
		input.runtimeText !== undefined ||
		input.approvesPlan ||
		input.continueOn
	)
		return {};
	const session = await agentSessionForOwner(scope.userId, scope.sessionId);
	if (
		session?.turnStatus !== "running" ||
		session.harness !== scope.harnessId ||
		(scope.projectId && session.projectId !== scope.projectId)
	)
		return { session };
	const messageId = input.idempotencyKey ?? randomUUID();
	if (sendWasQueued(sessionItemsFromUnknown(session.items), messageId))
		return { view: await publicSessionView(scope) };
	const attachments = input.storedAttachments
		? [...input.storedAttachments]
		: await storeMessageAttachments(
				scope.userId,
				session.id,
				input.attachments,
			);
	const [item] = sessionItemsQueuedWithUser(
		[],
		input.text,
		messageId,
		false,
		attachments,
	);
	if (item?.kind !== "userMessage") return {};
	const outcome = await queueUserMessageWhileRunning(scope.userId, session.id, {
		item,
		message: await queuedModelText(scope.userId, session.id, item),
		harnessId: scope.harnessId,
		modelId: input.modelId,
		...(input.variant ? { variant: input.variant } : {}),
		...(input.speed ? { speed: input.speed } : {}),
		...(input.fast !== undefined ? { fast: input.fast } : {}),
	});
	// The turn ended meanwhile: this send starts the next one with the stored files.
	if (outcome === "not-running") return { storedAttachments: attachments };
	return { view: await publicSessionView(scope) };
}

/** What the model reads for a queued message: its text, files and mention note. */
async function queuedModelText(
	userId: string,
	sessionId: string,
	item: UserMessageItem,
) {
	const text = withAttachmentNote(item.text, item.attachments);
	const note = await mentionNoteFor(userId, sessionId, item.text).catch(
		() => null,
	);
	return note ? `${text}\n\n${note}` : text;
}

/**
 * Starts the next turn with the oldest message still waiting once the chat's
 * turn has ended (completed, failed or stopped). A message whose turn cannot
 * start goes back to the front of the queue, still visible and removable.
 */
export async function startQueuedUserTurn(
	machines: WorkspaceMachines,
	userId: string,
	sessionId: string,
) {
	const next = await takeNextQueuedUserMessage(userId, sessionId);
	if (!next) return;
	try {
		const session = await agentSessionForOwner(userId, sessionId);
		if (!session) return;
		const view = await Effect.runPromise(
			sendComposerMessage(
				machines,
				{
					userId,
					projectId: session.projectId,
					sessionId,
					harnessId: next.harnessId,
					createNew: false,
				},
				{
					text: next.item.text,
					modelId: next.modelId,
					...(next.variant ? { variant: next.variant } : {}),
					...(next.speed ? { speed: next.speed } : {}),
					...(next.fast !== undefined ? { fast: next.fast } : {}),
					idempotencyKey: next.item.id,
					storedAttachments: next.item.attachments ?? [],
				},
			),
		);
		if (view.connection.status === "failed")
			throw new Error(view.connection.message);
	} catch (cause) {
		await restoreQueuedUserMessage(sessionId, next).catch(() => {});
		console.warn(
			"A queued message could not start its turn; it waits in the chat.",
			cause instanceof Error ? cause.name : "unknown",
		);
	}
}

/** Stop keeps the queued messages: the first of them starts the next turn. */
export function stopTurnKeepingQueue(
	machines: WorkspaceMachines,
	scope: HarnessSessionScope,
): Effect.Effect<PublicCodexSession> {
	return Effect.flatMap(stopHarnessWorkspaceTurn(scope), (view) =>
		Effect.promise(async () => {
			// A turn that never started settles at once; a running one starts the
			// queue itself when its executor finishes stopping it.
			if (scope.sessionId && view.turnStatus !== "running")
				await startQueuedUserTurn(machines, scope.userId, scope.sessionId);
			return publicSessionView(scope);
		}),
	);
}

export function removeQueuedComposerMessage(
	scope: HarnessSessionScope,
	messageId: string,
): Effect.Effect<PublicCodexSession> {
	return Effect.promise(async () => {
		if (!scope.sessionId) throw new Error("Select a chat first.");
		if (
			!(await removeQueuedUserMessage(scope.userId, scope.sessionId, messageId))
		)
			throw new Error("That message was already delivered.");
		return publicSessionView(scope);
	});
}

/** A chat as the browser sees it: its transcript, then the messages still waiting. */
export async function publicSessionView(
	scope: HarnessSessionScope,
): Promise<PublicCodexSession> {
	return withQueuedMessages(
		await Effect.runPromise(readHarnessWorkspaceSession(scope)),
	);
}

export async function withQueuedMessages(
	view: PublicCodexSession,
): Promise<PublicCodexSession> {
	if (!view.agentSessionId) return view;
	const queued = await queuedUserMessageItems(view.agentSessionId);
	return queued.length
		? { ...view, items: withQueuedUserMessages(view.items, queued) }
		: view;
}
