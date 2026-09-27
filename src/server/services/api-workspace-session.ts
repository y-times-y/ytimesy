import {
	apiConversation,
	assertApiContextFits,
} from "#/domain/api-conversation";
import {
	parseModelRouteId,
	verifiedConnectionModels,
} from "#/domain/model-connection";
import {
	sessionItemsFromUnknown,
	sessionItemsQueuedWithUser,
} from "#/domain/session-item";
import { agentSessionForOwner } from "../adapters/agent-sessions";
import { cancelApiTurn, enqueueApiTurn } from "../adapters/api-turns";
import {
	listModelConnections,
	loadModelConnection,
} from "../adapters/model-connections";
import { openAgentSession } from "./agent-session-machine";
import {
	type CodexSessionScope,
	emptyCodexSession,
} from "./codex-workspace-session";

export async function apiModelCatalog(userId: string) {
	const connections = await listModelConnections(userId);
	return verifiedConnectionModels(connections);
}

export async function readApiWorkspaceSession(scope: CodexSessionScope) {
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
		workspaceId: session?.providerRef ?? null,
		items: sessionItemsFromUnknown(session?.items),
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
	input: { text: string; modelId: string },
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
	const selected = parseModelRouteId(input.modelId);
	if (!selected) throw new Error("Select an API connection and model.");
	const connection = await loadModelConnection(
		scope.userId,
		selected.connectionId,
	);
	if (
		!connection?.models.some(
			(model) => model.id === selected.modelId && model.toolStreamingVerified,
		)
	)
		throw new Error("Verify this model connection before using it.");
	const items = sessionItemsQueuedWithUser(
		sessionItemsFromUnknown(session.items),
		input.text,
	);
	const messages = apiConversation(items);
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
	});
	return readApiWorkspaceSession(scope);
}

export async function stopApiWorkspaceTask(scope: CodexSessionScope) {
	if (!scope.sessionId) throw new Error("Select a chat first.");
	await readApiWorkspaceSession(scope);
	await cancelApiTurn(scope.userId, scope.sessionId);
	return readApiWorkspaceSession(scope);
}
