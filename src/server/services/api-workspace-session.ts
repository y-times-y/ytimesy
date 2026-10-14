import { pendingPlanId } from "#/domain/agent-plan";
import {
	apiConversation,
	assertApiContextFits,
} from "#/domain/api-conversation";
import { type ApiModelSpeedId, apiModelSpeeds } from "#/domain/api-model-list";
import { childTaskPublicItems } from "#/domain/child-task-activity";
import { reconstructedContextTransition } from "#/domain/harness-model-profile";
import {
	type IncomingAttachment,
	withAttachmentNote,
} from "#/domain/message-attachment";
import { parseModelRouteId } from "#/domain/model-connection";
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
import { agentSessionForOwner } from "../adapters/agent-sessions";
import {
	enqueueApiTurn,
	inheritedApiTurnSettings,
	previousTurnMessages,
} from "../adapters/api-turns";
import {
	listModelConnections,
	loadModelConnection,
} from "../adapters/model-connections";
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

export async function apiModelCatalog(userId: string) {
	return availableApiModelRoutes(await listModelConnections(userId));
}

export async function readApiWorkspaceSession(
	scope: CodexSessionScope,
): Promise<PublicCodexSession> {
	const session = scope.sessionId
		? await agentSessionForOwner(scope.userId, scope.sessionId)
		: null;
	if (session && session.projectId !== scope.projectId)
		throw new Error("Session is not in this project.");
	const models = await apiModelCatalog(scope.userId);
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
		runtimeText?: string;
		idempotencyKey?: string;
		approvesPlan?: boolean;
		attachments?: readonly IncomingAttachment[];
		/** A fallback route the user approved for this turn (`<connection>|<model>`). */
		continueOn?: string;
	},
	preparedTask = false,
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
		// Opening claimed the chat; a rejected send hands it back.
		return releasingChatClaimOnFailure(
			scope.userId,
			opened.id,
			input.text,
			() =>
				sendApiWorkspaceTask(
					{ ...scope, sessionId: opened.id },
					input,
					preparedTask,
				),
		);
	}
	const session = await agentSessionForOwner(
		scope.userId,
		scope.sessionId as string,
	);
	if (!session || session.projectId !== scope.projectId)
		throw new Error("Session is not available.");
	const selected = parseModelRouteId(input.modelId);
	if (!selected) throw new Error("Select an API connection and model.");
	const connection = await loadModelConnection(
		scope.userId,
		selected.connectionId,
	);
	if (
		!connection ||
		!(await availableApiModelRoutes([connection])).some(
			(model) => model.id === input.modelId,
		)
	)
		throw new Error(
			"The selected model is no longer available on this connection.",
		);
	const settings =
		input.speed === undefined && input.variant === undefined
			? await inheritedApiTurnSettings(
					scope.userId,
					session.id,
					selected.modelId,
					connection.id,
				)
			: {
					...(input.variant ? { reasoning: input.variant } : {}),
					...(input.speed && input.speed !== "standard"
						? { speed: input.speed }
						: {}),
				};
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
	const attachments = await storeMessageAttachments(
		scope.userId,
		session.id,
		input.attachments,
	);
	const items = sessionItemsQueuedWithUser(
		current,
		input.text,
		input.idempotencyKey,
		input.approvesPlan,
		attachments,
	);
	const previous = await previousTurnMessages(
		scope.userId,
		session.id,
		selected.modelId,
		connection.revision,
	);
	let messages = previous
		? [
				...previous,
				{
					role: "user" as const,
					content: withAttachmentNote(
						input.runtimeText ?? input.text,
						attachments,
					),
				},
			]
		: apiConversation(items);
	if (input.runtimeText)
		messages[messages.length - 1] = {
			role: "user",
			content: withAttachmentNote(input.runtimeText, attachments),
		};
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
	// The sidebar shows the stored title; name the chat after its first message.
	await titleUntitledAgentSession(
		scope.userId,
		session.id,
		sessionTitleFromItems(items),
	).catch(() => undefined);
	return readApiWorkspaceSession(scope);
}

export async function stopApiWorkspaceTask(scope: CodexSessionScope) {
	if (!scope.sessionId) throw new Error("Select a chat first.");
	await readApiWorkspaceSession(scope);
	await cancelServerTurn(scope.userId, scope.sessionId);
	return readApiWorkspaceSession(scope);
}
