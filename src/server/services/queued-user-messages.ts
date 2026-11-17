import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { parseSteering } from "#/domain/agent-steering";
import {
	ENVIRONMENT_SETUP_PROMPT,
	initialSetupMessageId,
} from "#/domain/environment-setup";
import type { MessageAttachment } from "#/domain/message-attachment";
import { withAttachmentNote } from "#/domain/message-attachment";
import { QUEUED_MESSAGES_PER_CHAT_LIMIT } from "#/domain/peer-inbox-injection";
import {
	firstEnvironmentBuildRunning,
	sendWaitsForEnvironment,
	startsSetupBesideTask,
	workspaceEnvironmentIsReady,
} from "#/domain/project-workspace";
import { type MergedQueuedTurn, mergedQueuedTurn } from "#/domain/queued-merge";
import type { UserMessageItem } from "#/domain/session-item";
import {
	sendWasQueued,
	sessionItemsFromUnknown,
	sessionItemsQueuedWithUser,
	sessionTitleFromText,
	withQueuedUserMessages,
} from "#/domain/session-item";
import {
	latestTranscriptPage,
	TRANSCRIPT_PAGE_TURNS,
} from "#/domain/transcript-page";
import { startAfterResponse } from "../adapters/after-response";
import {
	type AgentSessionRecord,
	agentSessionMetadataForOwner,
	agentSessionPageForOwner,
	claimChatForSend,
	claimInitialSetupChat,
	insertAgentSession,
	reusableEmptyChat,
	sessionHoldsUserMessage,
} from "../adapters/agent-sessions";
import {
	backgroundJobId,
	dispatchBackgroundJob,
} from "../adapters/background-job-dispatch";
import {
	markEnvironmentSetupChat,
	otherProjectSetupChat,
} from "../adapters/environment-setup-chats";
import {
	chatHoldingMessage,
	chatsWithReleasableHeldSends,
	holdUserMessageForSetup,
	type QueuedUserSend,
	queuedUserMessageItems,
	queueUserMessageWhileRunning,
	releaseHeldUserMessages,
	releaseQueuedUserMessage,
	removeQueuedUserMessage,
	restoreQueuedUserMessages,
	takeNextQueuedUserMessage,
	takeNextQueuedUserMessages,
	updateQueuedUserMessage,
} from "../adapters/queued-user-messages";
import { workspaceForProject } from "../adapters/workspaces";
import { relayConversationDeliveriesOnce } from "../jobs/conversation-delivery";
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
	requested: HarnessSessionScope,
	input: ComposerSend,
): Effect.Effect<PublicCodexSession> {
	return Effect.flatMap(
		Effect.promise(
			async (): Promise<
				| { readonly view: PublicCodexSession }
				| {
						readonly storedAttachments?: readonly MessageAttachment[];
						readonly session?: AgentSessionRecord | null;
						readonly scope: HarnessSessionScope;
				  }
			> => {
				const started = await initialSetupStarted(requested, input);
				if (started && "view" in started) return { view: started.view };
				// A project's own setup start sends into the chat it claimed.
				const scope = started?.scope ?? requested;
				const queued = await timed("send:queueCheck", () =>
					queueBehindRunningTurn(machines, scope, input),
				);
				if ("view" in queued) return queued;
				const held = await holdUntilEnvironmentReady(
					machines,
					scope,
					input,
					queued,
				);
				if (held) return { view: held };
				await timed("send:setupBeside", () =>
					startProjectSetupBesideTask(machines, scope, input),
				);
				return {
					storedAttachments: queued.storedAttachments,
					session: queued.session,
					scope,
				};
			},
		),
		(queued) =>
			"view" in queued
				? Effect.succeed(queued.view)
				: sendHarnessWorkspaceTask(
						machines,
						queued.scope,
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

/**
 * A new project starts its setup by itself, once: its request carries the
 * project's own message id (initialSetupMessageId). Another start of it (a
 * second tab, a reload, a retried request) gets the chat that already has
 * it instead of a second setup.
 *
 * A start into a new chat claims the project's one setup chat in the
 * database (claimInitialSetupChat: a fixed id, insert or get), so two
 * starts at the same moment get one chat, and only the start that created
 * it sends: one turn. A chat a start created but never sent into (its
 * request died) is taken over by the next start after a short while.
 */
async function initialSetupStarted(
	scope: HarnessSessionScope,
	input: ComposerSend,
): Promise<
	{ view: PublicCodexSession } | { scope: HarnessSessionScope } | null
> {
	if (
		!input.environmentSetup ||
		// Its own delivery once the environment is ready is not another start.
		input.released ||
		!scope.projectId ||
		input.idempotencyKey !== initialSetupMessageId(scope.projectId)
	)
		return null;
	const projectId = scope.projectId;
	const current = scope.createNew ? null : (scope.sessionId ?? null);
	const holding = await chatHoldingMessage(
		scope.userId,
		projectId,
		input.idempotencyKey,
	);
	const existing =
		holding && holding !== current
			? holding
			: await otherProjectSetupChat(scope.userId, projectId, current);
	if (existing)
		return {
			view: await publicSessionView({
				...scope,
				sessionId: existing,
				createNew: false,
			}),
		};
	if (current) return null;
	const workspace = await workspaceForProject(scope.userId, projectId);
	if (!workspace) return null;
	const claimed = await claimInitialSetupChat({
		userId: scope.userId,
		projectId,
		workspaceId: workspace.id,
		harness: scope.harnessId,
		title: sessionTitleFromText(input.text),
	});
	if (!claimed) return null;
	const own = { ...scope, sessionId: claimed.session.id, createNew: false };
	if (claimed.created || (await setupStartAbandoned(claimed.session, input)))
		return { scope: own };
	return { view: await publicSessionView(own) };
}

/** A start's chat that never got its request (the start died before sending). */
async function setupStartAbandoned(
	session: AgentSessionRecord,
	input: ComposerSend,
) {
	if (Date.now() - new Date(session.createdAt).getTime() < 30_000) return false;
	if (sessionItemsFromUnknown(session.items).length) return false;
	const waiting = await queuedUserMessageItems(session.id);
	return !waiting.some((item) => item.id === input.idempotencyKey);
}

async function queueBehindRunningTurn(
	machines: WorkspaceMachines,
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
	// The chat's row only: a send's transcript is asked in the database
	// (sessionHoldsUserMessage), never read whole here (megabytes per send).
	let session = await agentSessionMetadataForOwner(
		scope.userId,
		scope.sessionId,
	);
	if (!session || (scope.projectId && session.projectId !== scope.projectId))
		return {};
	const messageId = input.idempotencyKey ?? randomUUID();
	if (session.turnStatus !== "running") {
		// A turn shows ended a while before its end takes the next waiting
		// message (publication, reports). A send in that window must not jump
		// ahead: the oldest waiting message starts now and this one queues
		// behind it. A message the queue itself delivers never comes here.
		if (input.released) return {};
		const waiting = (await queuedUserMessageItems(session.id)).filter(
			(item) => !item.heldForSetup,
		);
		if (!waiting.length) return {};
		const started = await startQueuedUserTurn(
			machines,
			scope.userId,
			session.id,
		);
		// A replay of a send that is itself waiting: starting the queue sent it.
		if (waiting.some((item) => item.id === messageId))
			return { view: await publicSessionView(scope) };
		// The waiting message could not start: this send goes as before.
		if (!started) return {};
		session = await agentSessionMetadataForOwner(scope.userId, session.id);
		if (session?.turnStatus !== "running") return {};
	}
	// A merged batch is one turn's start: queued alone it would drop the
	// earlier messages (deliverQueuedSend puts them all back).
	if (input.merged) throw new Error("A turn is already running.");
	if (await sessionHoldsUserMessage(scope.userId, session.id, messageId))
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
		...(input.alternateContext !== undefined
			? { alternateContext: input.alternateContext }
			: {}),
		released: input.released === true,
	});
	if (outcome === "full")
		throw new Error(
			`This chat already has ${QUEUED_MESSAGES_PER_CHAT_LIMIT} messages waiting. Wait for some to be delivered, or remove one, before sending another.`,
		);
	// The turn ended meanwhile: this send starts the next one with the stored files.
	if (outcome === "not-running") return { storedAttachments: attachments };
	return { view: await publicSessionView(scope) };
}

/**
 * The project's setup request, sent while its environment is not ready
 * (being built, or the build failed), waits in its chat, stored like a
 * queued message: the setup agent starts from the build's report, so it
 * starts once the environment is ready (deliverHeldSends), even with no tab
 * open. The chat lists in the sidebar and every device shows it. Null for
 * any other send: a task never waits for setup (its machine boots fresh,
 * sessionMachinePlan), and when the environment is ready or missing.
 */
async function holdUntilEnvironmentReady(
	machines: WorkspaceMachines,
	scope: HarnessSessionScope,
	input: ComposerSend,
	known: { readonly session?: AgentSessionRecord | null },
): Promise<PublicCodexSession | null> {
	if (!scope.projectId || !sendWaitsForEnvironment(input)) return null;
	const projectId = scope.projectId;
	const workspace = await workspaceForProject(scope.userId, projectId);
	if (!workspace || workspaceEnvironmentIsReady(workspace)) return null;
	const messageId = input.idempotencyKey ?? randomUUID();
	const session = await chatForHeldSend(
		scope,
		projectId,
		workspace.id,
		messageId,
		input.text,
		known.session,
	);
	// An opened, untitled chat is named after the message, as a send names it.
	await claimChatForSend(scope.userId, session.id, input.text);
	// A setup request marks its chat as the project's setup chat now, not
	// when the build finishes: it never publishes, and a second start finds it.
	if (input.environmentSetup)
		await markEnvironmentSetupChat(
			scope.userId,
			session.id,
			sessionTitleFromText(input.text),
		);
	const sessionScope = { ...scope, sessionId: session.id, createNew: false };
	const waiting = await queuedUserMessageItems(session.id);
	if (
		!waiting.some((item) => item.id === messageId) &&
		// The held transcript when the caller read it, else asked of the
		// database: the chat was read without it.
		!(Array.isArray(session.items)
			? sendWasQueued(sessionItemsFromUnknown(session.items), messageId)
			: await sessionHoldsUserMessage(scope.userId, session.id, messageId))
	) {
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
		if (item?.kind !== "userMessage") return null;
		await holdUserMessageForSetup(scope.userId, session.id, {
			item,
			message: await queuedModelText(scope.userId, session.id, item),
			harnessId: scope.harnessId,
			modelId: input.modelId,
			...(input.variant ? { variant: input.variant } : {}),
			...(input.speed ? { speed: input.speed } : {}),
			...(input.fast !== undefined ? { fast: input.fast } : {}),
			...(input.alternateContext !== undefined
				? { alternateContext: input.alternateContext }
				: {}),
			...(input.baseBranch ? { baseBranch: input.baseBranch } : {}),
			...(input.environmentSetup ? { environmentSetup: true } : {}),
		});
		// The build may have finished while this was stored: its release ran
		// before the message was there, so it goes now.
		const now = await workspaceForProject(scope.userId, projectId);
		if (workspaceEnvironmentIsReady(now))
			await deliverHeldSendsInChat(machines, scope.userId, session.id);
	}
	return publicSessionView(sessionScope);
}

/**
 * A task sent while the project's first build runs starts at once on its own
 * machine, and the project's setup still runs: its chat is opened beside the
 * task (the project's one setup chat, as a tab starts it: same message id,
 * claimed once) with the setup request waiting in it for the build. Nothing
 * here navigates; the chat appears in the sidebar. A failure only skips the
 * setup chat (Rerun setup in Settings starts it); the task goes on.
 */
async function startProjectSetupBesideTask(
	machines: WorkspaceMachines,
	scope: HarnessSessionScope,
	input: ComposerSend,
) {
	if (!scope.projectId || !startsSetupBesideTask(input)) return;
	const projectId = scope.projectId;
	try {
		const workspace = await workspaceForProject(scope.userId, projectId);
		if (!workspace || !firstEnvironmentBuildRunning(workspace)) return;
		const setup: ComposerSend = {
			text: ENVIRONMENT_SETUP_PROMPT,
			modelId: input.modelId,
			...(input.variant ? { variant: input.variant } : {}),
			...(input.speed ? { speed: input.speed } : {}),
			...(input.fast !== undefined ? { fast: input.fast } : {}),
			idempotencyKey: initialSetupMessageId(projectId),
			environmentSetup: true,
		};
		const started = await initialSetupStarted(
			{ ...scope, sessionId: undefined, createNew: true },
			setup,
		);
		if (!started || "view" in started) return;
		await holdUntilEnvironmentReady(machines, started.scope, setup, {});
	} catch (error) {
		console.warn("The project's setup chat could not be started.", {
			message: error instanceof Error ? error.message.slice(0, 200) : "unknown",
		});
	}
}

/**
 * The chat a held send waits in: the open one, the one a replay of it
 * already landed in, or a new chat named after it (an unused one first).
 */
async function chatForHeldSend(
	scope: HarnessSessionScope,
	projectId: string,
	workspaceId: string,
	messageId: string,
	text: string,
	known?: AgentSessionRecord | null,
): Promise<Omit<AgentSessionRecord, "items"> & { readonly items?: unknown }> {
	if (scope.sessionId && !scope.createNew) {
		// Without its transcript unless the caller already holds it: the send
		// checks for its message in the database instead.
		const session =
			known?.id === scope.sessionId
				? known
				: await agentSessionMetadataForOwner(scope.userId, scope.sessionId);
		if (!session || session.projectId !== projectId)
			throw new Error("Agent session is not available.");
		return session;
	}
	const landed = await chatHoldingMessage(scope.userId, projectId, messageId);
	const replayed =
		landed && (await agentSessionMetadataForOwner(scope.userId, landed));
	if (replayed) return replayed;
	const title = sessionTitleFromText(text);
	return (
		(await reusableEmptyChat(
			scope.userId,
			projectId,
			scope.harnessId,
			title,
		)) ??
		(await insertAgentSession({
			userId: scope.userId,
			projectId,
			workspaceId,
			harness: scope.harnessId,
			title,
		}))
	);
}

/**
 * The environment is ready: each chat's held messages are released and the
 * first starts its turn, once (the take is atomic; a replay finds nothing).
 * The build's finish dispatches this for its workspace; the periodic sweep
 * catches any it missed.
 */
export async function deliverHeldSends(
	machines: WorkspaceMachines,
	workspaceId?: string,
) {
	const chats = await chatsWithReleasableHeldSends(workspaceId);
	let started = 0;
	for (const chat of chats)
		if (await deliverHeldSendsInChat(machines, chat.userId, chat.sessionId))
			started += 1;
	return started;
}

/**
 * The periodic sweep: a release the build's finish did not dispatch (lost,
 * or a path that readies the environment without a build) goes as a job per
 * workspace, on the job runner's model routes.
 */
export async function dispatchReleasableHeldSends(nowMs = Date.now()) {
	const chats = await chatsWithReleasableHeldSends();
	const minute = Math.floor(nowMs / 60_000);
	for (const workspaceId of new Set(chats.map((chat) => chat.workspaceId)))
		await dispatchBackgroundJob({
			id: backgroundJobId(`held-sends:sweep:${workspaceId}:${minute}`),
			kind: "held-sends",
			workspaceId,
		});
}

async function deliverHeldSendsInChat(
	machines: WorkspaceMachines,
	userId: string,
	sessionId: string,
) {
	// Released first: if the start below fails, the message stays in the
	// chat as an ordinary waiting one (Send, Edit, Remove), never dropped.
	if (!(await releaseHeldUserMessages(sessionId))) return false;
	const next = await takeNextQueuedUserMessage(userId, sessionId);
	if (!next) return false;
	return deliverQueuedSend(machines, userId, sessionId, [next]);
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
 * turn has ended (completed, failed or stopped), together with the messages
 * right behind it that may share its turn (one round trip: takeNextQueuedUserMessages).
 * Messages that cannot start their turn go back to the front of the queue,
 * still visible and removable.
 */
export async function startQueuedUserTurn(
	machines: WorkspaceMachines,
	userId: string,
	sessionId: string,
) {
	const batch = await takeNextQueuedUserMessages(userId, sessionId);
	if (!batch.length) return false;
	return deliverQueuedSend(machines, userId, sessionId, batch);
}

/**
 * Starts a turn with the waiting messages taken together: one message, or
 * several of one origin merged (queued-merge.ts: each keeps its own bubble,
 * the model reads one numbered request; the last message is the send, its id
 * the turn's idempotency key, and all were taken, so delivered, together). A
 * failure puts them all back at the front of the queue, in order. Send and
 * the turn-end drain share this. Returns whether the turn started.
 */
async function deliverQueuedSend(
	machines: WorkspaceMachines,
	userId: string,
	sessionId: string,
	batch: readonly QueuedUserSend[],
): Promise<boolean> {
	const next = batch[batch.length - 1];
	if (!next) return false;
	const merged: MergedQueuedTurn | undefined = mergedQueuedTurn(batch);
	const restore = () => restoreQueuedUserMessages(sessionId, batch);
	try {
		const session = await agentSessionMetadataForOwner(userId, sessionId);
		if (!session) {
			await restore().catch(() => {});
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
					// An agent's queued message (agent_send) starts the turn with the
					// text the model reads (the sender's role note), as its steering does.
					...(parseSteering(next.item.text) && next.message !== next.item.text
						? { runtimeText: merged?.modelText ?? next.message }
						: {}),
					...(merged ? { merged } : {}),
					modelId: next.modelId,
					...(next.variant ? { variant: next.variant } : {}),
					...(next.speed ? { speed: next.speed } : {}),
					...(next.fast !== undefined ? { fast: next.fast } : {}),
					...(next.alternateContext !== undefined
						? { alternateContext: next.alternateContext }
						: {}),
					idempotencyKey: next.item.id,
					storedAttachments: next.item.attachments ?? [],
					...(next.baseBranch ? { baseBranch: next.baseBranch } : {}),
					...(next.environmentSetup ? { environmentSetup: true } : {}),
					released: true,
				},
			),
		);
		if (view.connection.status === "failed")
			throw new Error(view.connection.message);
		return true;
	} catch (cause) {
		await restore().catch(() => {});
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
	return Effect.flatMap(stopHarnessWorkspaceTurn(scope), () =>
		Effect.promise(async () => {
			// One read after the stop (the browser already shows it stopped).
			const view = await publicSessionView(scope);
			// A turn that never started settles at once; a running one starts the
			// queue itself when its executor finishes stopping it.
			if (
				scope.sessionId &&
				view.turnStatus !== "running" &&
				(await startQueuedUserTurn(machines, scope.userId, scope.sessionId))
			)
				return publicSessionView(scope);
			return view;
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
	/** "Fix with the agent" on a held message: it goes as a setup chat's request. */
	environmentSetup = false,
): Effect.Effect<PublicCodexSession> {
	return Effect.promise(async () => {
		await rewriteQueuedText(scope, messageId, text, environmentSetup);
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
		// Marked for the running turn: the chat's object gets the view now, not
		// at its next step, and tells a Claude Code run's hooks to fetch it
		// (claude-feed.ts). A failed relay keeps its receipt for the step.
		if (outcome.status === "running") {
			const sessionId = scope.sessionId;
			const relay = () => relayConversationDeliveriesOnce(sessionId);
			if (!startAfterResponse(relay)) void relay().catch(() => {});
		}
		if (outcome.status === "taken") {
			const started = await deliverQueuedSend(
				machines,
				scope.userId,
				scope.sessionId,
				[outcome.send],
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
	environmentSetup = false,
) {
	if (!scope.sessionId) throw new Error("Select a chat first.");
	const trimmed = text.trim();
	if (!trimmed) throw new Error("Message text is required.");
	const waiting = await queuedUserMessageItems(scope.sessionId);
	const current = waiting.find((item) => item.id === messageId);
	if (!current) throw new Error("That message was already delivered.");
	const {
		queued: _queued,
		released: _released,
		heldForSetup: _held,
		...item
	} = current;
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
			environmentSetup,
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
