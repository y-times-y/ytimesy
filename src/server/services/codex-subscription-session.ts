import {
	apiConversation,
	assertApiContextFits,
} from "#/domain/api-conversation";
import { recordedContextUsage } from "#/domain/api-progress";
import { childTaskPublicItems } from "#/domain/child-task-activity";
import { reconstructedContextTransition } from "#/domain/harness-model-profile";
import {
	sessionItemsFromUnknown,
	sessionItemsQueuedWithUser,
} from "#/domain/session-item";
import { subscriptionTurnRevision } from "#/domain/subscription-turn";
import { agentSessionForOwner } from "../adapters/agent-sessions";
import {
	enqueueApiTurn,
	inheritedSubscriptionSettings,
	previousTurnMessages,
} from "../adapters/api-turns";
import { codexSubscriptionCatalog } from "../adapters/codex-subscription";
import { hasManagedCodexAuth } from "../auth/codex-managed-auth";
import { openAgentSession } from "./agent-session-machine";
import { cancelServerTurn } from "./cancel-server-turn";
import {
	type CodexSessionScope,
	emptyCodexSession,
	type PublicCodexSession,
} from "./codex-workspace-session";

/** Database transcript and account catalog only. Reading a chat never starts native Codex or a VM. */
export async function readSubscriptionSession(
	scope: CodexSessionScope,
): Promise<PublicCodexSession> {
	const session = scope.sessionId
		? await agentSessionForOwner(scope.userId, scope.sessionId)
		: null;
	if (scope.sessionId && (!session || session.projectId !== scope.projectId))
		throw new Error("Session is not in this project.");
	const connected = await hasManagedCodexAuth(scope.userId);
	const models = connected ? await codexSubscriptionCatalog(scope.userId) : [];
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
		connection: connected
			? {
					status: "authenticated",
					provider: "codex",
					authMode: "chatgpt",
					planType: null,
					email: null,
				}
			: { status: "disconnected" },
	};
}

export async function sendSubscriptionTask(
	scope: CodexSessionScope,
	input: {
		text: string;
		modelId: string;
		runtimeText?: string;
		variant?: string;
		fast?: boolean;
		idempotencyKey?: string;
	},
	preparedTask = false,
) {
	if (!scope.projectId)
		throw new Error("Select a project chat before sending.");
	if (!scope.sessionId) {
		const opened = await openAgentSession({
			userId: scope.userId,
			projectId: scope.projectId,
			harness: "codex",
		});
		scope = { ...scope, sessionId: opened.id };
	}
	const view = await readSubscriptionSession(scope);
	if (!view.models.some((model) => model.id === input.modelId))
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
	const items = sessionItemsQueuedWithUser(view.items, input.text);
	const previous = await previousTurnMessages(
		scope.userId,
		scope.sessionId as string,
		input.modelId,
		revision,
	);
	let messages = previous
		? [
				...previous,
				{ role: "user" as const, content: input.runtimeText ?? input.text },
			]
		: apiConversation(items);
	if (!previous && input.runtimeText)
		messages[messages.length - 1] = {
			role: "user",
			content: input.runtimeText,
		};
	if (!previous)
		messages = reconstructedContextTransition(messages, input.modelId);
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
	});
	return readSubscriptionSession(scope);
}

export async function stopSubscriptionTask(scope: CodexSessionScope) {
	await readSubscriptionSession(scope);
	if (!scope.sessionId) throw new Error("Select a chat first.");
	await cancelServerTurn(scope.userId, scope.sessionId);
	return readSubscriptionSession(scope);
}
