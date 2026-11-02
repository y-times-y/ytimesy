import { pendingPlanId } from "#/domain/agent-plan";
import {
	assertApiContextFits,
	nextTurnMessages,
} from "#/domain/api-conversation";
import { type ApiModelSpeedId, apiModelSpeeds } from "#/domain/api-model-list";
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
	parseModelRouteId,
} from "#/domain/model-connection";
import type { SendBlocker } from "#/domain/send-blocked";
import {
	sendWasQueued,
	sessionItemsFromUnknown,
	sessionItemsQueuedWithUser,
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
	descendantAgentSessions,
} from "../adapters/agent-sessions";
import {
	enqueueApiTurn,
	inheritedApiTurnSettings,
	previousTurnMessages,
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
				: await agentSessionForOwner(scope.userId, scope.sessionId)
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
		/** Sent from "Set up environment" (its first send only). */
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
	const [session, connection, inherited] = await Promise.all([
		read?.id === sessionId
			? read
			: agentSessionForOwner(scope.userId, sessionId),
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
		!(await availableApiModelRoutes([connection])).some(
			(model) => model.id === input.modelId,
		)
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
		(connection.provider !== "openrouter" ||
			!apiModelSpeeds(selected.modelId).some(
				(speed) => speed.id === settings.speed,
			))
	)
		throw new Error(
			`${settings.speed === "ultrafast" ? "Ultrafast" : "Fast"} mode is not available for this model on this connection.`,
		);
	const current = sessionItemsFromUnknown(session.items);
	// The send's key is its message id: a replayed request was already queued.
	if (sendWasQueued(current, input.idempotencyKey))
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
	if (input.approvesPlan && !pendingPlanId(current))
		throw new Error("That plan was already answered.");
	const [attachments, previous] = await Promise.all([
		input.storedAttachments
			? [...input.storedAttachments]
			: storeMessageAttachments(scope.userId, session.id, input.attachments),
		previousTurnMessages(
			scope.userId,
			session.id,
			selected.modelId,
			connection.revision,
		),
	]);
	const items = sessionItemsQueuedWithUser(
		current,
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
		attachments,
	});
	if (!previous)
		messages = reconstructedContextTransition(
			messages,
			failover?.route.modelId ?? selected.modelId,
		);
	assertApiContextFits(messages);
	await enqueueApiTurn({
		userId: scope.userId,
		sessionId: session.id,
		connectionId: connection.id,
		revision: connection.revision,
		modelId: selected.modelId,
		routeId: input.modelId,
		messages,
		items,
		preparedTask,
		idempotencyKey: input.idempotencyKey,
		settings,
		failover,
	});
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
	// running turn on the route it was sent to. Re-reading it would repeat
	// the chat and catalog reads above.
	return apiWorkspaceView(
		{
			...session,
			items,
			turnStatus: "running",
			harness: "api",
			listedModelId: input.modelId,
		},
		await catalog,
	);
}

/**
 * A send to a Claude Code model: the turn runs the Claude Code CLI on the
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
	const [session, connected] = await Promise.all([
		read?.id === sessionId
			? read
			: agentSessionForOwner(scope.userId, sessionId),
		claudeCodeSendable(scope.userId),
	]);
	if (!session || session.projectId !== scope.projectId)
		throw new Error("Session is not available.");
	if (!connected)
		throw new Error(
			"Connect your Claude subscription in Settings > Agents first.",
		);
	const current = sessionItemsFromUnknown(session.items);
	if (sendWasQueued(current, input.idempotencyKey))
		return readApiWorkspaceSession(scope);
	const revision = claudeCodeTurnRevision();
	const failover = input.continueOn
		? await pinnedTurnFailover(
				scope.userId,
				{
					connectionId: null,
					connectionRevision: revision,
					modelId,
					settings: {},
				},
				input.continueOn,
			)
		: undefined;
	if (input.approvesPlan && !pendingPlanId(current))
		throw new Error("That plan was already answered.");
	const [attachments, previous] = await Promise.all([
		input.storedAttachments
			? [...input.storedAttachments]
			: storeMessageAttachments(scope.userId, session.id, input.attachments),
		previousTurnMessages(scope.userId, session.id, modelId, revision),
	]);
	const items = sessionItemsQueuedWithUser(
		current,
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
		attachments,
	});
	if (!previous)
		messages = reconstructedContextTransition(
			messages,
			failover?.route.modelId ?? modelId,
		);
	assertApiContextFits(messages);
	await enqueueApiTurn({
		userId: scope.userId,
		sessionId: session.id,
		connectionId: null,
		revision,
		modelId,
		routeId: input.modelId,
		messages,
		items,
		preparedTask,
		idempotencyKey: input.idempotencyKey,
		settings: {},
		failover,
	});
	const title = () =>
		titleUntitledAgentSession(
			scope.userId,
			session.id,
			sessionTitleFromItems(items),
		).catch(() => undefined);
	if (!startAfterResponse(title)) await title();
	return apiWorkspaceView(
		{
			...session,
			items,
			turnStatus: "running",
			harness: "api",
			listedModelId: input.modelId,
		},
		await catalog,
	);
}

export async function stopApiWorkspaceTask(scope: CodexSessionScope) {
	if (!scope.sessionId) throw new Error("Select a chat first.");
	await readApiWorkspaceSession(scope);
	await cancelServerTurn(scope.userId, scope.sessionId);
	// Stop on a parent stops its whole subagent tree; cancelled children send no reports.
	const { userId } = scope;
	await Promise.all(
		(await descendantAgentSessions(userId, scope.sessionId))
			.filter((child) => child.agentRole && child.turnStatus === "running")
			.map((child) => cancelServerTurn(userId, child.id).catch(() => {})),
	);
	return readApiWorkspaceSession(scope);
}
