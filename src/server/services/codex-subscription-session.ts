import type { AgentConnection } from "#/domain/agent-connection";
import { pendingPlanId } from "#/domain/agent-plan";
import {
	assertApiContextFits,
	nextTurnMessages,
} from "#/domain/api-conversation";
import { recordedContextUsage } from "#/domain/api-progress";
import { CodexReconnectRequired } from "#/domain/api-turn-failure";
import { childTaskPublicItems } from "#/domain/child-task-activity";
import { reconstructedContextTransition } from "#/domain/harness-model-profile";
import type {
	IncomingAttachment,
	MessageAttachment,
} from "#/domain/message-attachment";
import {
	sendWasQueued,
	sessionItemsFromUnknown,
	sessionItemsQueuedWithUser,
	sessionTitleFromItems,
} from "#/domain/session-item";
import { subscriptionTurnRevision } from "#/domain/subscription-turn";
import {
	chatHoldingSend,
	releasingChatClaimOnFailure,
	titleUntitledAgentSession,
} from "#/server/adapters/agent-sessions";
import { agentSessionForOwner } from "../adapters/agent-sessions";
import {
	enqueueApiTurn,
	inheritedSubscriptionSettings,
	previousTurnMessages,
} from "../adapters/api-turns";
import { codexSubscriptionCatalog } from "../adapters/codex-subscription";
import { loadAgentAccount } from "../auth/agent-account";
import {
	type CodexDeviceLogin,
	readCodexDeviceLogin,
	startCodexDeviceLogin,
} from "../auth/codex-device-login";
import { hasManagedCodexAuth } from "../auth/codex-managed-auth";
import { openAgentSession } from "./agent-session-machine";
import { cancelServerTurn } from "./cancel-server-turn";
import {
	type CodexSessionScope,
	emptyCodexSession,
	type PublicCodexSession,
} from "./codex-workspace-session";
import { storeMessageAttachments } from "./message-attachments";
import { pinnedTurnFailover } from "./model-failover";

/** Database transcript and account catalog only. Reading a chat never starts native Codex or a VM. */
async function readSubscriptionSession(
	scope: CodexSessionScope,
	/** A follow-up that continues on a fallback works while the plan's catalog is down. */
	tolerateCatalogOutage = false,
): Promise<PublicCodexSession> {
	const session = scope.sessionId
		? await agentSessionForOwner(scope.userId, scope.sessionId)
		: null;
	if (scope.sessionId && (!session || session.projectId !== scope.projectId))
		throw new Error("Session is not in this project.");
	let connected = await hasManagedCodexAuth(scope.userId);
	let models: Awaited<ReturnType<typeof codexSubscriptionCatalog>> = [];
	try {
		if (connected) models = await codexSubscriptionCatalog(scope.userId);
	} catch (error) {
		// A rejected refresh has just marked the account expired; show sign-in instead.
		if (error instanceof CodexReconnectRequired) connected = false;
		else if (!tolerateCatalogOutage) throw error;
	}
	const account = await loadAgentAccount(scope.userId);
	const connection: AgentConnection =
		connected && account.status === "connected"
			? {
					status: "authenticated",
					provider: "codex",
					authMode: "chatgpt",
					planType: account.planType,
					email: account.email,
				}
			: account.status === "expired"
				? { status: "expired", provider: "codex", message: account.message }
				: { status: "disconnected" };
	const items = childTaskPublicItems(sessionItemsFromUnknown(session?.items));
	return {
		...emptyCodexSession(),
		items,
		models,
		usage: recordedContextUsage(items),
		agentSessionId: session?.id ?? null,
		workspaceId: session?.providerRef ?? null,
		selectedBranch:
			session?.selectedBranch ?? session?.workingBranch ?? session?.taskBranch,
		listedModelId:
			session?.harness === "codex" ? (session.listedModelId ?? "") : "",
		turnStatus: session?.turnStatus ?? "idle",
		canSend: connected && models.length > 0,
		connection,
	};
}

/** The chat view, showing a ChatGPT sign-in the server is waiting on. */
export async function readSubscriptionLoginSession(
	scope: CodexSessionScope,
): Promise<PublicCodexSession> {
	const view = await readSubscriptionSession(scope);
	if (view.connection.status === "authenticated") return view;
	return withDeviceLogin(view, await readCodexDeviceLogin(scope.userId));
}

/** Connect: an unconnected account starts a server-side ChatGPT sign-in. */
export async function connectSubscriptionSession(
	scope: CodexSessionScope,
): Promise<PublicCodexSession> {
	const view = await readSubscriptionSession(scope);
	if (view.connection.status === "authenticated") return view;
	try {
		return withDeviceLogin(view, await startCodexDeviceLogin(scope.userId));
	} catch (cause) {
		return withDeviceLogin(view, {
			status: "failed",
			message:
				cause instanceof Error
					? cause.message
					: "Could not start ChatGPT sign-in.",
		});
	}
}

function deviceLoginConnection(
	login: CodexDeviceLogin,
): AgentConnection | null {
	if (login.status === "pending")
		return {
			status: "awaiting_device_code",
			provider: "codex",
			loginId: login.userCode,
			verificationUrl: login.verificationUrl,
			userCode: login.userCode,
		};
	if (login.status === "failed")
		return { status: "failed", provider: "codex", message: login.message };
	return null;
}

function withDeviceLogin(
	view: PublicCodexSession,
	login: CodexDeviceLogin,
): PublicCodexSession {
	const connection = deviceLoginConnection(login);
	return connection ? { ...view, connection, canSend: false } : view;
}

export async function sendSubscriptionTask(
	scope: CodexSessionScope,
	input: {
		text: string;
		modelId: string;
		runtimeText?: string;
		/** A runtime-switch envelope, sent only when no structured history carries over. */
		runtimeHandoff?: string;
		variant?: string;
		fast?: boolean;
		idempotencyKey?: string;
		approvesPlan?: boolean;
		attachments?: readonly IncomingAttachment[];
		/** Files a queued message already put in private storage. */
		storedAttachments?: readonly MessageAttachment[];
		/** A fallback route the user approved for this turn (`<connection>|<model>`). */
		continueOn?: string;
	},
	preparedTask = false,
): ReturnType<typeof readSubscriptionSession> {
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
			return sendSubscriptionTask(
				{ ...scope, sessionId: landed },
				input,
				preparedTask,
			);
		const opened = await openAgentSession({
			userId: scope.userId,
			projectId: scope.projectId,
			harness: "codex",
			firstMessage: input.text,
		});
		// Opening claimed the chat; a rejected send hands it back.
		return releasingChatClaimOnFailure(
			scope.userId,
			opened.id,
			input.text,
			() =>
				sendSubscriptionTask(
					{ ...scope, sessionId: opened.id },
					input,
					preparedTask,
				),
		);
	}
	const task = await agentSessionForOwner(
		scope.userId,
		scope.sessionId as string,
	);
	if (!task || task.projectId !== scope.projectId)
		throw new Error("Session is not available.");
	const continuing = Boolean(input.continueOn);
	const view = await readSubscriptionSession(scope, continuing);
	// Continuing on a fallback during an outage: the fallback route is checked below.
	if (!continuing && !view.models.some((model) => model.id === input.modelId))
		throw new Error("Selected subscription model is unavailable.");
	const inherited =
		input.variant === undefined && input.fast === undefined
			? await inheritedSubscriptionSettings(
					scope.userId,
					scope.sessionId as string,
					input.modelId,
				)
			: null;
	const revision = subscriptionTurnRevision(
		input.variant ?? inherited?.reasoning,
		input.fast ?? inherited?.fast,
	);
	// The send's key is its message id: a replayed request was already queued.
	if (sendWasQueued(view.items, input.idempotencyKey))
		return readSubscriptionSession(scope, continuing);
	const failover = input.continueOn
		? await pinnedTurnFailover(
				scope.userId,
				{
					connectionId: null,
					connectionRevision: revision,
					modelId: input.modelId,
				},
				input.continueOn,
			)
		: undefined;
	if (input.approvesPlan && !pendingPlanId(view.items))
		throw new Error("That plan was already answered.");
	const attachments = input.storedAttachments
		? [...input.storedAttachments]
		: await storeMessageAttachments(
				scope.userId,
				scope.sessionId as string,
				input.attachments,
			);
	const items = sessionItemsQueuedWithUser(
		view.items,
		input.text,
		input.idempotencyKey,
		input.approvesPlan,
		attachments,
	);
	const previous = await previousTurnMessages(
		scope.userId,
		scope.sessionId as string,
		input.modelId,
		revision,
	);
	let messages = nextTurnMessages({
		previous,
		items,
		text: input.text,
		runtimeText: input.runtimeText,
		handoff: input.runtimeHandoff,
		attachments,
	});
	if (!previous)
		messages = reconstructedContextTransition(
			messages,
			failover?.route.modelId ?? input.modelId,
		);
	assertApiContextFits(messages);
	await enqueueApiTurn({
		userId: scope.userId,
		sessionId: scope.sessionId as string,
		connectionId: null,
		revision,
		modelId: input.modelId,
		routeId: input.modelId,
		messages,
		items,
		preparedTask,
		idempotencyKey: input.idempotencyKey,
		failover,
	});
	// The sidebar shows the stored title; name the chat after its first message.
	await titleUntitledAgentSession(
		scope.userId,
		scope.sessionId as string,
		sessionTitleFromItems(items),
	).catch(() => undefined);
	return readSubscriptionSession(scope, continuing);
}

export async function stopSubscriptionTask(scope: CodexSessionScope) {
	await readSubscriptionSession(scope);
	if (!scope.sessionId) throw new Error("Select a chat first.");
	await cancelServerTurn(scope.userId, scope.sessionId);
	return readSubscriptionSession(scope);
}
