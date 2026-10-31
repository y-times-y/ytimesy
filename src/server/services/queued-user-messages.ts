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
	latestTranscriptPage,
	TRANSCRIPT_PAGE_TURNS,
} from "#/domain/transcript-page";
import {
	type AgentSessionRecord,
	agentSessionForOwner,
	agentSessionPageForOwner,
} from "../adapters/agent-sessions";
import {
	type QueuedUserSend,
	queuedUserMessageItems,
	queueUserMessageWhileRunning,
	releaseQueuedUserMessage,
	removeQueuedUserMessage,
	restoreQueuedUserMessage,
	takeNextQueuedUserMessage,
	updateQueuedUserMessage,
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

type ComposerSend = Parameters<typeof sendHarnessWorkspaceTask>[2] & {
	/**
	 * A message the turn-end drain or Send already took. If the turn is running
	 * again by the time it is stored, it stays marked for the next step.
	 */
	readonly released?: boolean;
};

function harnessTask(
	input: ComposerSend,
): Parameters<typeof sendHarnessWorkspaceTask>[2] {
	const { released: _released, ...task } = input;
	return task;
}

/**
 * The person's own send: while the chat's turn runs it waits in that chat
 * (editable until Send; the turn's end sends it too). Otherwise it starts a
 * turn. Runtime sends (notices, plan approvals, fallback continuations) never
 * queue.
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
							...harnessTask(input),
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
		// Send, or the turn ending, is what the model receives. Until then it
		// stays out of the next step so Edit can still change it.
		released: input.released === true,
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
	await deliverQueuedSend(machines, userId, sessionId, next);
}

/**
 * Starts a turn with one waiting message. A failure puts that message back
 * at the front of the queue. Send and the turn-end drain share this.
 * Returns whether the turn started.
 */
async function deliverQueuedSend(
	machines: WorkspaceMachines,
	userId: string,
	sessionId: string,
	next: QueuedUserSend,
): Promise<boolean> {
	try {
		const session = await agentSessionForOwner(userId, sessionId);
		if (!session) {
			await restoreQueuedUserMessage(sessionId, next).catch(() => {});
			return false;
		}
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
					released: true,
				},
			),
		);
		if (view.connection.status === "failed")
			throw new Error(view.connection.message);
		return true;
	} catch (cause) {
		await restoreQueuedUserMessage(sessionId, next).catch(() => {});
		console.warn(
			"A queued message could not start its turn; it waits in the chat.",
			cause instanceof Error ? cause.name : "unknown",
		);
		return false;
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

/** Replaces the text of a message the model has not received yet. */
export function updateQueuedComposerMessage(
	scope: HarnessSessionScope,
	messageId: string,
	text: string,
): Effect.Effect<PublicCodexSession> {
	return Effect.promise(async () => {
		await rewriteQueuedText(scope, messageId, text);
		return publicSessionView(scope);
	});
}

/**
 * Send on a queued message. A running turn keeps the tool call; the message
 * is marked for the next step. A finished turn starts now.
 */
export function releaseQueuedComposerMessage(
	machines: WorkspaceMachines,
	scope: HarnessSessionScope,
	messageId: string,
	text?: string,
): Effect.Effect<PublicCodexSession> {
	return Effect.promise(async () => {
		if (!scope.sessionId) throw new Error("Select a chat first.");
		if (text !== undefined) await rewriteQueuedText(scope, messageId, text);
		const outcome = await releaseQueuedUserMessage(
			scope.userId,
			scope.sessionId,
			messageId,
		);
		if (outcome.status === "missing")
			throw new Error("That message was already delivered.");
		if (outcome.status === "taken") {
			const started = await deliverQueuedSend(
				machines,
				scope.userId,
				scope.sessionId,
				outcome.send,
			);
			if (!started) throw new Error("That message could not be sent.");
		}
		return publicSessionView(scope);
	});
}

async function rewriteQueuedText(
	scope: HarnessSessionScope,
	messageId: string,
	text: string,
) {
	if (!scope.sessionId) throw new Error("Select a chat first.");
	const trimmed = text.trim();
	if (!trimmed) throw new Error("Message text is required.");
	const waiting = await queuedUserMessageItems(scope.sessionId);
	const current = waiting.find((item) => item.id === messageId);
	if (!current) throw new Error("That message was already delivered.");
	const { queued: _queued, released: _released, ...item } = current;
	const message = await queuedModelText(scope.userId, scope.sessionId, {
		...item,
		text: trimmed,
	});
	if (
		!(await updateQueuedUserMessage(
			scope.userId,
			scope.sessionId,
			messageId,
			trimmed,
			message,
		))
	)
		throw new Error("That message was already delivered.");
}

/**
 * A chat as the browser sees it: its last turns (the database reads only
 * those; older ones load as the reader scrolls up), then the messages still
 * waiting.
 */
export async function publicSessionView(
	scope: HarnessSessionScope,
): Promise<PublicCodexSession> {
	// The queue is read beside the chat (opening a chat waits on both); it
	// joins the view only if the view is that chat.
	const queued = scope.sessionId
		? queuedUserMessageItems(scope.sessionId)
		: null;
	queued?.catch(() => {});
	const reading = scope.sessionId
		? agentSessionPageForOwner(scope.userId, scope.sessionId, {
				turns: TRANSCRIPT_PAGE_TURNS,
			})
		: undefined;
	const view = await Effect.runPromise(
		readHarnessWorkspaceSession(scope, reading),
	);
	const page = await reading;
	return withQueuedMessages(
		page?.hasOlderItems && view.agentSessionId === page.id
			? { ...view, hasOlderItems: true }
			: view,
		queued && view.agentSessionId === scope.sessionId ? queued : undefined,
	);
}

/**
 * A view built from the whole transcript (a send, a stop, a connect), as
 * the browser gets it: the chat's last turns. Messages still waiting are
 * added after this.
 */
function latestPageView(view: PublicCodexSession): PublicCodexSession {
	const page = latestTranscriptPage(view.items);
	return page.hasOlderItems
		? { ...view, items: page.items, hasOlderItems: true }
		: view;
}

export async function withQueuedMessages(
	whole: PublicCodexSession,
	/** The chat's queue, already being read. */
	reading?: ReturnType<typeof queuedUserMessageItems>,
): Promise<PublicCodexSession> {
	const view = latestPageView(whole);
	if (!view.agentSessionId) return view;
	const queued = await (reading ?? queuedUserMessageItems(view.agentSessionId));
	return queued.length
		? { ...view, items: withQueuedUserMessages(view.items, queued) }
		: view;
}
