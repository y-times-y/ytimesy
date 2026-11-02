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
	type AgentSessionRecord,
	chatHoldingSend,
	releasingChatClaimOnFailure,
	titleUntitledAgentSession,
} from "#/server/adapters/agent-sessions";
import { startAfterResponse } from "../adapters/after-response";
import { agentSessionForOwner } from "../adapters/agent-sessions";
import {
	enqueueApiTurn,
	inheritedSubscriptionSettings,
	previousTurnMessages,
} from "../adapters/api-turns";
import { codexSubscriptionCatalog } from "../adapters/codex-subscription";
import { loadAgentAccount, loadAgentAccountState } from "../auth/agent-account";
import {
	type CodexDeviceLogin,
	deviceLoginFromSealed,
	startCodexDeviceLogin,
} from "../auth/codex-device-login";
import { openAgentSession } from "./agent-session-machine";
import { cancelServerTurn } from "./cancel-server-turn";
import {
	type CodexSessionScope,
	emptyCodexSession,
	type PublicCodexSession,
} from "./codex-workspace-session";
import { storeMessageAttachments } from "./message-attachments";
import { pinnedTurnFailover } from "./model-failover";
import { githubSendBlocked } from "./send-blockers";
import { commitChatBranchForSubmission } from "./session-branch";
import { timed } from "./step-timing";

/** Database transcript and account catalog only. Reading a chat never starts native Codex or a VM. */
async function readSubscriptionSession(
	scope: CodexSessionScope,
	/** A follow-up that continues on a fallback works while the plan's catalog is down. */
	tolerateCatalogOutage = false,
	/** The chat as the caller just read or wrote it (or is reading it), instead of reading it again. */
	read?: AgentSessionRecord | Promise<AgentSessionRecord | null>,
): Promise<PublicCodexSession> {
	return (
		await readSubscriptionSessionState(scope, tolerateCatalogOutage, read)
	).view;
}

/** The view, and the account's sealed pending sign-in read with it. */
async function readSubscriptionSessionState(
	scope: CodexSessionScope,
	tolerateCatalogOutage = false,
	read?: AgentSessionRecord | Promise<AgentSessionRecord | null>,
): Promise<{ view: PublicCodexSession; sealedDeviceLogin: string | null }> {
	// Independent reads; the account row (login, status, pending sign-in) is
	// one read, again below only when a catalog refresh has just expired it.
	const [session, state] = await Promise.all([
		scope.sessionId
			? read instanceof Promise
				? read
				: read?.id === scope.sessionId
					? read
					: agentSessionForOwner(scope.userId, scope.sessionId)
			: null,
		loadAgentAccountState(scope.userId),
	]);
	const { managed, account: listedAccount } = state;
	if (scope.sessionId && (!session || session.projectId !== scope.projectId))
		throw new Error("Session is not in this project.");
	// Read beside the catalog; it settles (never rejects) before the view returns.
	const githubMissing = githubSendBlocked(scope.userId, session ?? null);
	let connected = managed;
	let expired = false;
	let models: Awaited<ReturnType<typeof codexSubscriptionCatalog>> = [];
	try {
		if (connected) models = await codexSubscriptionCatalog(scope.userId);
	} catch (error) {
		// A rejected refresh has just marked the account expired; show sign-in instead.
		if (error instanceof CodexReconnectRequired) {
			connected = false;
			expired = true;
		} else if (!tolerateCatalogOutage) throw error;
	}
	const account = expired
		? await loadAgentAccount(scope.userId)
		: listedAccount;
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
	const view: PublicCodexSession = {
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
		...((await githubMissing) ? { sendBlockers: ["github"] as const } : {}),
	};
	return { view, sealedDeviceLogin: state.sealedDeviceLogin };
}

/** The chat view, showing a ChatGPT sign-in the server is waiting on. */
export async function readSubscriptionLoginSession(
	scope: CodexSessionScope,
	/** The chat as the caller read it (by id, for this user), or is reading it. */
	read?: AgentSessionRecord | Promise<AgentSessionRecord | null>,
): Promise<PublicCodexSession> {
	const { view, sealedDeviceLogin } = await readSubscriptionSessionState(
		scope,
		false,
		read,
	);
	if (view.connection.status === "authenticated") return view;
	return withDeviceLogin(
		view,
		await deviceLoginFromSealed(sealedDeviceLogin, scope.userId),
	);
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
		/** The branch a new chat starts from (its first send only). */
		baseBranch?: string;
		/** Sent from "Set up environment" (its first send only). */
		environmentSetup?: boolean;
	},
	preparedTask = false,
	/** The chat as the caller just read or wrote it (by id, for this user). */
	read?: AgentSessionRecord,
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
		// Opening claimed the chat; a rejected send hands it back. Its branch
		// is committed as for a send into an open chat, so the turn knows the
		// commit its new branch starts from before its VM is ready.
		const projectId = scope.projectId;
		return releasingChatClaimOnFailure(
			scope.userId,
			opened.id,
			input.text,
			async () =>
				sendSubscriptionTask(
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
	const continuing = Boolean(input.continueOn);
	// The chat view (its row, the account and catalog) and the settings the
	// turn inherits are independent reads.
	const [view, inherited] = await timed("send:view", () =>
		Promise.all([
			readSubscriptionSession(scope, continuing, read),
			input.variant === undefined && input.fast === undefined
				? inheritedSubscriptionSettings(
						scope.userId,
						scope.sessionId as string,
						input.modelId,
					)
				: null,
		]),
	);
	if (!view.agentSessionId) throw new Error("Session is not available.");
	// Continuing on a fallback during an outage: the fallback route is checked below.
	if (!continuing && !view.models.some((model) => model.id === input.modelId))
		throw new Error("Selected subscription model is unavailable.");
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
	const [attachments, previous] = await Promise.all([
		input.storedAttachments
			? [...input.storedAttachments]
			: storeMessageAttachments(
					scope.userId,
					scope.sessionId as string,
					input.attachments,
				),
		previousTurnMessages(
			scope.userId,
			scope.sessionId as string,
			input.modelId,
			revision,
		),
	]);
	const items = sessionItemsQueuedWithUser(
		view.items,
		input.text,
		input.idempotencyKey,
		input.approvesPlan,
		attachments,
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
	await timed("send:enqueue", () =>
		enqueueApiTurn({
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
		}),
	);
	// The sidebar shows the stored title; name the chat after its first
	// message. A composer send already titled it when it claimed the chat, so
	// this is a fallback and need not hold the response.
	const title = () =>
		titleUntitledAgentSession(
			scope.userId,
			scope.sessionId as string,
			sessionTitleFromItems(items),
		).catch(() => undefined);
	if (!startAfterResponse(title)) await title();
	// The chat as just committed: its transcript with the sent message and a
	// running turn on the model it was sent to. Re-reading it would repeat
	// the chat, account and catalog reads above.
	const visible = childTaskPublicItems(items);
	return {
		...view,
		items: visible,
		usage: recordedContextUsage(visible),
		listedModelId: input.modelId,
		turnStatus: "running",
	};
}

/** Stops first, like stopApiWorkspaceTask; the caller reads the view after. */
export async function stopSubscriptionTask(scope: CodexSessionScope) {
	if (!scope.sessionId) throw new Error("Select a chat first.");
	await cancelServerTurn(scope.userId, scope.sessionId);
}
