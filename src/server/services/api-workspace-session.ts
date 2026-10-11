import {
	apiConversation,
	assertApiContextFits,
} from "#/domain/api-conversation";
import { childTaskPublicItems } from "#/domain/child-task-activity";
import { reconstructedContextTransition } from "#/domain/harness-model-profile";
import { parseModelRouteId } from "#/domain/model-connection";
import {
	sessionItemsFromUnknown,
	sessionItemsQueuedWithUser,
} from "#/domain/session-item";
import { agentSessionForOwner } from "../adapters/agent-sessions";
import { isServerControlledIntegration } from "../adapters/agent-task-command-receipts";
import { enqueueApiTurn, previousTurnMessages } from "../adapters/api-turns";
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
import { availableApiModelRoutes } from "./model-connections";

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
		runtimeText?: string;
		idempotencyKey?: string;
		mode?: "plan";
	},
	preparedTask = false,
) {
	if (!scope.projectId)
		throw new Error("Select a project chat before sending.");
	if (!scope.sessionId) {
		const opened = await openAgentSession({
			userId: scope.userId,
			projectId: scope.projectId,
			harness: "api",
		});
		scope = { ...scope, sessionId: opened.id };
	}
	const session = await agentSessionForOwner(
		scope.userId,
		scope.sessionId as string,
	);
	if (!session || session.projectId !== scope.projectId)
		throw new Error("Session is not available.");
	if (await isServerControlledIntegration(session))
		throw new Error(
			"Batch integration is server-controlled until a visible integration failure requires repair.",
		);
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
	const items = sessionItemsQueuedWithUser(
		sessionItemsFromUnknown(session.items),
		input.text,
		undefined,
		input.mode,
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
				{ role: "user" as const, content: input.runtimeText ?? input.text },
			]
		: apiConversation(items);
	if (input.runtimeText)
		messages[messages.length - 1] = {
			role: "user",
			content: input.runtimeText,
		};
	if (!previous)
		messages = reconstructedContextTransition(messages, selected.modelId);
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
	});
	return readApiWorkspaceSession(scope);
}

export async function stopApiWorkspaceTask(scope: CodexSessionScope) {
	if (!scope.sessionId) throw new Error("Select a chat first.");
	await readApiWorkspaceSession(scope);
	await cancelServerTurn(scope.userId, scope.sessionId);
	return readApiWorkspaceSession(scope);
}
