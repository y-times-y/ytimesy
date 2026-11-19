import { randomUUID } from "node:crypto";
import type { ModelMessage } from "ai";
import { pendingPlanId } from "#/domain/agent-plan";
import {
	assertApiContextFits,
	nextTurnMessages,
} from "#/domain/api-conversation";
import type { ApiModelSpeedId } from "#/domain/api-model-list";
import { childTaskPublicItems } from "#/domain/child-task-activity";
import {
	claudeCodeListedModels,
	claudeCodeTurnRevision,
	claudeSubscriptionEnabled,
	parseClaudeCodeRouteId,
} from "#/domain/claude-code-route";
import { reconstructedContextTransition } from "#/domain/harness-model-profile";
import type {
	IncomingAttachment,
	MessageAttachment,
} from "#/domain/message-attachment";
import {
	apiContextWindowOption,
	connectionModelSpeeds,
	parseModelRouteId,
} from "#/domain/model-connection";
import type { MergedQueuedTurn } from "#/domain/queued-merge";
import type { SendBlocker } from "#/domain/send-blocked";
import {
	queuedUserItem,
	type SessionItem,
	sendWasQueued,
	sessionItemsFromUnknown,
	sessionItemsQueuedWithUser,
	sessionItemsWithMergedUsers,
	sessionTitleFromItems,
} from "#/domain/session-item";
import {
	chatHoldingSend,
	releasingChatClaimOnFailure,
	titleUntitledAgentSession,
} from "#/server/adapters/agent-sessions";
import { startAfterResponse } from "../adapters/after-response";
import {
	type AgentSessionRecord,
	agentSessionForOwner,
	agentSessionMetadataForOwner,
	descendantAgentSessionMetadata,
	openPageForOwner,
	sessionHoldsUserMessage,
} from "../adapters/agent-sessions";
import { apiReasoningEffort } from "../adapters/api-reasoning-effort";
import {
	enqueueApiTurn,
	inheritedApiTurnSettings,
	previousTurnHistory,
	previousTurnMessages,
	type TurnBase,
	TurnBaseChanged,
} from "../adapters/api-turns";
import {
	claudeSubscriptionStatus,
	hasClaudeSubscription,
} from "../adapters/claude-subscription";
import {
	listModelConnections,
	loadModelConnection,
} from "../adapters/model-connections";
import { loadModelFailoverPreferences } from "../adapters/model-failover-preferences";
import { openAgentSession } from "./agent-session-machine";
import { cancelServerTurn } from "./cancel-server-turn";
import {
	type CodexSessionScope,
	emptyCodexSession,
	type PublicCodexSession,
} from "./codex-workspace-session";
import { storeMessageAttachments } from "./message-attachments";
import { availableApiModelRoutes } from "./model-connections";
import { pinnedTurnFailover } from "./model-failover";
import { githubSendBlocked } from "./send-blockers";
import { commitChatBranchForSubmission } from "./session-branch";

export async function apiModelCatalog(userId: string) {
	return (await apiModelAccess(userId)).models;
}

/** Failover moves a refused-token turn elsewhere, so the user's Claude model stays usable. */
function refusedClaudeListed(userId: string) {
	return loadModelFailoverPreferences(userId)
		.then((preferences) => preferences.enabled)
		.catch(() => false);
}

/** A Claude Code send can start: connected, or refused while failover is on. */
async function claudeCodeSendable(userId: string) {
	if (await hasClaudeSubscription(userId)) return true;
	const status = await claudeSubscriptionStatus(userId).catch(() => null);
	return status?.status === "refused" && (await refusedClaudeListed(userId));
}

/** The listed models, and whether Anthropic refused the saved Claude token. */
async function apiModelAccess(userId: string) {
	const [routes, claude] = await Promise.all([
		listModelConnections(userId).then(availableApiModelRoutes),
		claudeSubscriptionEnabled()
			? claudeSubscriptionStatus(userId)
					.then((status) => status.status)
					.catch(() => "disconnected" as const)
			: ("disconnected" as const),
	]);
	// Claude Code (the user's Claude subscription) lists beside API keys. A
	// refused token still lists while automatic failover is on: the chat
	// keeps the user's Claude model, and each turn continues elsewhere.
	const listed =
		claude === "connected" ||
		claude === "limited" ||
		(claude === "refused" && (await refusedClaudeListed(userId)));
	return {
		models: listed ? [...claudeCodeListedModels(), ...routes] : routes,
		claudeRefused: claude === "refused",
	};
}

export async function readApiWorkspaceSession(
	scope: CodexSessionScope,
	/** The chat as the caller read it (by id, for this user), or is reading it. */
	read?: AgentSessionRecord | Promise<AgentSessionRecord | null>,
): Promise<PublicCodexSession> {
	const session = scope.sessionId
		? read instanceof Promise
			? await read
			: read?.id === scope.sessionId
				? read
				: // The latest page (as the chat opens), never the whole transcript.
					await openPageForOwner(scope.userId, scope.sessionId)
		: null;
	if (session && session.projectId !== scope.projectId)
		throw new Error("Session is not in this project.");
	const [access, githubMissing] = await Promise.all([
		apiModelAccess(scope.userId),
		githubSendBlocked(scope.userId, session),
	]);
	const sendBlockers: SendBlocker[] = [
		...(access.models.length ? [] : (["no_model"] as const)),
		...(access.claudeRefused ? (["claude_token"] as const) : []),
		...(githubMissing ? (["github"] as const) : []),
	];
	return {
		...apiWorkspaceView(session, access.models),
		...((session as { hasOlderItems?: boolean } | null)?.hasOlderItems
			? { hasOlderItems: true }
			: {}),
		...(sendBlockers.length ? { sendBlockers } : {}),
	};
}

function apiWorkspaceView(
	session: Pick<
		AgentSessionRecord,
		| "id"
		| "selectedBranch"
		| "workingBranch"
		| "taskBranch"
		| "providerRef"
		| "items"
		| "turnStatus"
		| "harness"
		| "listedModelId"
	> | null,
	models: Awaited<ReturnType<typeof apiModelCatalog>>,
): PublicCodexSession {
	return {
		...emptyCodexSession(),
		models,
		agentSessionId: session?.id ?? null,
		selectedBranch:
			session?.selectedBranch ?? session?.workingBranch ?? session?.taskBranch,
		workspaceId: session?.providerRef ?? null,
		items: childTaskPublicItems(sessionItemsFromUnknown(session?.items)),
		turnStatus: session?.turnStatus ?? "idle",
		listedModelId:
			session?.harness === "api" ? (session.listedModelId ?? "") : "",
		canSend: models.length > 0,
		connection: models.length
			? {
					status: "authenticated" as const,
					provider: "api" as const,
					authMode: "apikey" as const,
					planType: null,
					email: null,
				}
			: { status: "disconnected" as const },
	};
}

export async function sendApiWorkspaceTask(
	scope: CodexSessionScope,
	input: {
		text: string;
		modelId: string;
		variant?: string;
		/** Absent on internal follow-ups, which keep the previous turn's settings. */
		speed?: "standard" | ApiModelSpeedId;
		/** The route's alternate context window; absent on internal follow-ups. */
		alternateContext?: boolean;
		/** Waiting messages delivered with this one as a single turn (queued-merge.ts). */
		merged?: MergedQueuedTurn;
		runtimeText?: string;
		idempotencyKey?: string;
		approvesPlan?: boolean;
		attachments?: readonly IncomingAttachment[];
		/** Files a queued message already put in private storage. */
		storedAttachments?: readonly MessageAttachment[];
		/** A fallback route the user approved for this turn (`<connection>|<model>`). */
		continueOn?: string;
		/** The branch a new chat starts from (its first send only). */
		baseBranch?: string;
		/** A project setup request (its first send only). */
		environmentSetup?: boolean;
	},
	preparedTask = false,
	/** The chat as the caller just read or wrote it (by id, for this user). */
	read?: AgentSessionRecord,
): ReturnType<typeof readApiWorkspaceSession> {
	if (!scope.projectId)
		throw new Error("Select a project chat before sending.");
	if (!scope.sessionId) {
		// A resent first message whose reply was lost lands in its own chat.
		const landed =
			input.idempotencyKey &&
			(await chatHoldingSend(
				scope.userId,
				scope.projectId,
				input.idempotencyKey,
			));
		if (landed)
			return sendApiWorkspaceTask(
				{ ...scope, sessionId: landed },
				input,
				preparedTask,
			);
		const opened = await openAgentSession({
			userId: scope.userId,
			projectId: scope.projectId,
			harness: "api",
			firstMessage: input.text,
		});
		// Opening claimed the chat; a rejected send hands it back. Its branch
		// is committed as for a send into an open chat, so the turn knows the
		// commit its new branch starts from before its VM is ready.
		const projectId = scope.projectId;
		return releasingChatClaimOnFailure(
			scope.userId,
			opened.id,
			input.text,
			async () =>
				sendApiWorkspaceTask(
					{ ...scope, sessionId: opened.id },
					input,
					preparedTask,
					await commitChatBranchForSubmission({
						userId: scope.userId,
						projectId,
						sessionId: opened.id,
						text: input.text,
						session: opened,
						baseBranch: input.baseBranch,
						environmentSetup: input.environmentSetup,
					}),
				),
		);
	}
	const sessionId = scope.sessionId;
	if (parseClaudeCodeRouteId(input.modelId))
		return sendClaudeCodeTask(scope, sessionId, input, preparedTask, read);
	const selected = parseModelRouteId(input.modelId);
	const inheritsSettings =
		input.speed === undefined &&
		input.variant === undefined &&
		input.alternateContext === undefined;
	// The chat, its connection, the settings it inherits and the catalog the
	// response shows are independent reads; each is checked in order below.
	const catalog = apiModelCatalog(scope.userId);
	catalog.catch(() => {});
	const held = heldTranscript(read, sessionId);
	const [session, connection, inherited] = await Promise.all([
		held && read ? read : agentSessionMetadataForOwner(scope.userId, sessionId),
		selected ? loadModelConnection(scope.userId, selected.connectionId) : null,
		selected && inheritsSettings
			? inheritedApiTurnSettings(
					scope.userId,
					sessionId,
					selected.modelId,
					selected.connectionId,
				)
			: null,
	]);
	if (!session || session.projectId !== scope.projectId)
		throw new Error("Session is not available.");
	if (!selected) throw new Error("Select an API connection and model.");
	if (
		!connection ||
		!(
			await availableApiModelRoutes([connection], { includeRetired: true })
		).some((model) => model.id === input.modelId)
	)
		throw new Error(
			"The selected model is no longer available on this connection.",
		);
	const settings = inheritsSettings
		? (inherited ?? {})
		: {
				...(input.variant ? { reasoning: input.variant } : {}),
				...(input.speed && input.speed !== "standard"
					? { speed: input.speed }
					: {}),
				...(input.alternateContext ? { alternateContext: true as const } : {}),
			};
	if (
		settings.alternateContext &&
		!apiContextWindowOption(connection, selected.modelId)
	)
		throw new Error(
			"That context window is not available for this model on this connection.",
		);
	if (
		settings.speed &&
		!connectionModelSpeeds(connection, selected.modelId).some(
			(speed) => speed.id === settings.speed,
		)
	)
		throw new Error(
			`${settings.speed === "ultrafast" ? "Ultrafast" : "Fast"} mode is not available for this model on this connection.`,
		);
	// The send's key is its message id: a replayed request was already queued.
	if (await alreadySent(scope, session.id, held, input.idempotencyKey))
		return readApiWorkspaceSession(scope);
	const failover = input.continueOn
		? await pinnedTurnFailover(
				scope.userId,
				{
					connectionId: connection.id,
					connectionRevision: connection.revision,
					modelId: selected.modelId,
					settings,
				},
				input.continueOn,
			)
		: undefined;
	const planned = input.approvesPlan
		? await wholeTranscript(scope, session.id, held)
		: held;
	if (input.approvesPlan && !pendingPlanId(planned ?? []))
		throw new Error("That plan was already answered.");
	const readPrevious = () =>
		previousTurnHistory(
			scope.userId,
			session.id,
			selected.modelId,
			connection.revision,
		);
	const [attachments, previous] = await Promise.all([
		input.storedAttachments
			? [...input.storedAttachments]
			: storeMessageAttachments(scope.userId, session.id, input.attachments),
		readPrevious(),
	]);
	const current =
		planned ??
		(previous ? null : await wholeTranscript(scope, session.id, held));
	const sent = sendItems(current, input, attachments);
	const items = sent.items;
	const readHistory = () =>
		previousTurnMessages(
			scope.userId,
			session.id,
			selected.modelId,
			connection.revision,
		);
	await enqueueContinuing(
		previous,
		readPrevious,
		readHistory,
		(history, base) => {
			let messages = nextTurnMessages({
				previous: history,
				items,
				text: input.text,
				runtimeText: input.runtimeText ?? input.merged?.modelText,
				// A merged turn's text already carries every attachment note.
				attachments: input.merged ? undefined : attachments,
			});
			if (!history)
				messages = reconstructedContextTransition(
					messages,
					failover?.route.modelId ?? selected.modelId,
				);
			assertApiContextFits(messages, base?.bytes);
			return enqueueApiTurn({
				userId: scope.userId,
				sessionId: session.id,
				connectionId: connection.id,
				revision: connection.revision,
				modelId: selected.modelId,
				routeId: input.modelId,
				messages,
				base,
				...sent.write,
				preparedTask,
				idempotencyKey: input.idempotencyKey,
				settings,
				failover,
			});
		},
	);
	// The sidebar shows the stored title; name the chat after its first
	// message. A composer send already titled it when it claimed the chat, so
	// this is a fallback and need not hold the response.
	const title = () =>
		titleUntitledAgentSession(
			scope.userId,
			session.id,
			sessionTitleFromItems(items),
		).catch(() => undefined);
	if (!startAfterResponse(title)) await title();
	// The chat as just committed: its transcript with the sent message and a
	// running turn on the route it was sent to.
	return sentView(scope, session, sent, input.modelId, catalog);
}

/**
 * A send to a Claude Code model: the turn runs Claude Code (Agent SDK) on the
 * chat's VM, billed to the user's Claude subscription (no API connection).
 */
async function sendClaudeCodeTask(
	scope: CodexSessionScope,
	sessionId: string,
	input: Parameters<typeof sendApiWorkspaceTask>[1],
	preparedTask: boolean,
	read?: AgentSessionRecord,
): ReturnType<typeof readApiWorkspaceSession> {
	const modelId = parseClaudeCodeRouteId(input.modelId);
	if (!modelId || !claudeSubscriptionEnabled())
		throw new Error("Claude Code is not available.");
	const catalog = apiModelCatalog(scope.userId);
	catalog.catch(() => {});
	const held = heldTranscript(read, sessionId);
	const [session, connected] = await Promise.all([
		held && read ? read : agentSessionMetadataForOwner(scope.userId, sessionId),
		claudeCodeSendable(scope.userId),
	]);
	if (!session || session.projectId !== scope.projectId)
		throw new Error("Session is not available.");
	// Y² has no machine for the Claude CLI: it needs a Claude runner box.
	// enqueueApiTurn refuses it from the chat row its gate statement already
	// reads (no read of its own here: a send pays no extra round trip).
	if (!connected)
		throw new Error(
			"Connect your Claude subscription in Settings > Agents first.",
		);
	if (await alreadySent(scope, session.id, held, input.idempotencyKey))
		return readApiWorkspaceSession(scope);
	const revision = claudeCodeTurnRevision();
	const effort = apiReasoningEffort(input.variant);
	const failover = input.continueOn
		? await pinnedTurnFailover(
				scope.userId,
				{
					connectionId: null,
					connectionRevision: revision,
					modelId,
					settings: effort ? { reasoning: effort } : {},
				},
				input.continueOn,
			)
		: undefined;
	const planned = input.approvesPlan
		? await wholeTranscript(scope, session.id, held)
		: held;
	if (input.approvesPlan && !pendingPlanId(planned ?? []))
		throw new Error("That plan was already answered.");
	const readPrevious = () =>
		previousTurnHistory(scope.userId, session.id, modelId, revision);
	const [attachments, previous] = await Promise.all([
		input.storedAttachments
			? [...input.storedAttachments]
			: storeMessageAttachments(scope.userId, session.id, input.attachments),
		readPrevious(),
	]);
	// The model's messages continue the stored ones; only without them is the
	// whole transcript read (they are rebuilt from it).
	const current =
		planned ??
		(previous ? null : await wholeTranscript(scope, session.id, held));
	const sent = sendItems(current, input, attachments);
	const items = sent.items;
	const readHistory = () =>
		previousTurnMessages(scope.userId, session.id, modelId, revision);
	await enqueueContinuing(
		previous,
		readPrevious,
		readHistory,
		(history, base) => {
			let messages = nextTurnMessages({
				previous: history,
				items,
				text: input.text,
				runtimeText: input.runtimeText ?? input.merged?.modelText,
				// A merged turn's text already carries every attachment note.
				attachments: input.merged ? undefined : attachments,
			});
			if (!history)
				messages = reconstructedContextTransition(
					messages,
					failover?.route.modelId ?? modelId,
				);
			assertApiContextFits(messages, base?.bytes);
			return enqueueApiTurn({
				userId: scope.userId,
				sessionId: session.id,
				connectionId: null,
				revision,
				modelId,
				routeId: input.modelId,
				messages,
				base,
				...sent.write,
				preparedTask,
				idempotencyKey: input.idempotencyKey,
				// The chosen effort, when it is one Claude takes; anything else is dropped.
				settings: effort ? { reasoning: effort } : {},
				failover,
			});
		},
	);
	const title = () =>
		titleUntitledAgentSession(
			scope.userId,
			session.id,
			sessionTitleFromItems(items),
		).catch(() => undefined);
	if (!startAfterResponse(title)) await title();
	return sentView(scope, session, sent, input.modelId, catalog);
}

type PreviousTurn = Awaited<ReturnType<typeof previousTurnHistory>>;

/**
 * Queues a send on the history it continues: a settled turn's identity when
 * it continues unchanged (the database copies its history; the send never
 * reads it), else the history itself. When that turn changed before the
 * send was queued, it is planned again once, then on the history itself.
 */
async function enqueueContinuing(
	previous: PreviousTurn,
	readPrevious: () => Promise<PreviousTurn>,
	readHistory: () => Promise<ModelMessage[] | null>,
	enqueue: (
		history: ModelMessage[] | null,
		base: TurnBase | undefined,
	) => Promise<void>,
) {
	let current = previous;
	for (let attempt = 0; ; attempt++) {
		try {
			return await enqueue(
				current?.base ? [] : (current?.messages ?? null),
				current?.base,
			);
		} catch (error) {
			if (!(error instanceof TurnBaseChanged) || attempt >= 2) throw error;
			if (attempt === 0) current = await readPrevious();
			else {
				const messages = await readHistory();
				current = messages ? { messages } : null;
			}
			// The send was planned on a history (its items appended to the stored
			// transcript); with none now it would lose the conversation.
			if (!current) throw error;
		}
	}
}

/**
 * The transcript the caller already read, only when it really holds it: a
 * chat read without its transcript (metadata) must never pass for an empty
 * one, or the send would overwrite the stored transcript with its message.
 */
function heldTranscript(
	read: AgentSessionRecord | undefined,
	sessionId: string,
): readonly SessionItem[] | null {
	return read?.id === sessionId && Array.isArray(read.items)
		? sessionItemsFromUnknown(read.items)
		: null;
}

/** The chat's whole transcript: the one held, else read (megabytes; rare). */
async function wholeTranscript(
	scope: CodexSessionScope,
	sessionId: string,
	held: readonly SessionItem[] | null,
): Promise<readonly SessionItem[]> {
	if (held) return held;
	const whole = await agentSessionForOwner(scope.userId, sessionId);
	if (!whole || !Array.isArray(whole.items))
		throw new Error("Session is not available.");
	return sessionItemsFromUnknown(whole.items);
}

/** A replayed send: its message (keyed by its id) is already in the transcript. */
async function alreadySent(
	scope: CodexSessionScope,
	sessionId: string,
	held: readonly SessionItem[] | null,
	messageId: string | undefined,
) {
	if (!messageId) return false;
	return held
		? sendWasQueued(held, messageId)
		: sessionHoldsUserMessage(scope.userId, sessionId, messageId);
}

type SentItems = {
	/** The transcript after the send, or only its new items when appended. */
	readonly items: readonly SessionItem[];
	/** How enqueueApiTurn stores them. */
	readonly write:
		| { readonly items: readonly SessionItem[] }
		| {
				readonly items: readonly SessionItem[];
				readonly appendItems: readonly SessionItem[];
		  };
	readonly appended: boolean;
};

/**
 * The send's message added to the transcript: to the whole one when the send
 * holds it, else appended in the database (the transcript never read).
 */
function sendItems(
	current: readonly SessionItem[] | null,
	input: {
		readonly text: string;
		readonly idempotencyKey?: string;
		readonly approvesPlan?: boolean;
		readonly merged?: MergedQueuedTurn;
	},
	attachments: readonly MessageAttachment[],
): SentItems {
	const earlier = input.merged?.items ?? [];
	if (current) {
		const items = sessionItemsQueuedWithUser(
			sessionItemsWithMergedUsers(current, earlier),
			input.text,
			input.idempotencyKey,
			input.approvesPlan,
			attachments,
		);
		return { items, write: { items }, appended: false };
	}
	const item = queuedUserItem(
		input.text,
		input.idempotencyKey ?? `queued-user-${randomUUID()}`,
		input.approvesPlan,
		attachments,
	);
	if (!item) throw new Error("Write a message before sending.");
	return {
		items: [...earlier, item],
		write: { items: [], appendItems: [...earlier, item] },
		appended: true,
	};
}

/**
 * The view a send answers with: the whole transcript it wrote, or, when it
 * appended, the chat's latest page read from the database (not the whole).
 */
async function sentView(
	scope: CodexSessionScope,
	session: Omit<NonNullable<Parameters<typeof apiWorkspaceView>[0]>, "items">,
	sent: SentItems,
	listedModelId: string,
	catalog: ReturnType<typeof apiModelCatalog>,
): Promise<PublicCodexSession> {
	const page = sent.appended
		? await openPageForOwner(scope.userId, session.id)
		: null;
	const view = apiWorkspaceView(
		{
			...session,
			items: page ? page.items : sent.items,
			turnStatus: "running",
			harness: "api",
			listedModelId,
		},
		await catalog,
	);
	return page?.hasOlderItems ? { ...view, hasOlderItems: true } : view;
}

/**
 * Stops the chat's turn before anything else: reading the chat (and its model
 * catalog) waits on the network, and the stop must not. The cancel is fenced
 * by the owner, so it needs no earlier read; the caller reads the view after.
 */
export async function stopApiWorkspaceTask(scope: CodexSessionScope) {
	if (!scope.sessionId) throw new Error("Select a chat first.");
	const { userId, sessionId } = scope;
	await cancelServerTurn(userId, sessionId);
	// Stop on a parent stops its whole subagent tree; cancelled children send no reports.
	await Promise.all(
		(await descendantAgentSessionMetadata(userId, sessionId))
			.filter((child) => child.agentRole && child.turnStatus === "running")
			.map((child) => cancelServerTurn(userId, child.id).catch(() => {})),
	);
}
