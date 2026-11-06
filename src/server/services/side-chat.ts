import { Effect } from "effect";
import type { AgentProviderId } from "#/domain/agent-provider";
import {
	sessionItemsFromUnknown,
	sessionItemsQueuedWithUser,
} from "#/domain/session-item";
import {
	sideChatBudget,
	sideChatModelText,
	sideChatSendTarget,
} from "#/domain/side-chat";
import {
	type AgentSessionRecord,
	agentSessionForOwner,
	agentSessionMetadataForOwner,
	deleteAgentSessionForOwner,
	insertAgentSession,
	saveAgentTaskState,
	sideChatForParent,
} from "../adapters/agent-sessions";
import { queueUserMessageWhileRunning } from "../adapters/queued-user-messages";
import { saveSubagentSpec } from "../adapters/subagents";
import {
	type HarnessSessionScope,
	sendHarnessWorkspaceTask,
} from "./harness-workspace-session";
import { publicSessionView, withQueuedMessages } from "./queued-user-messages";
import type { WorkspaceMachines } from "./workspace-machines";

export type SideChatSend = {
	readonly userId: string;
	readonly projectId: string;
	readonly parentSessionId: string;
	readonly harnessId: AgentProviderId;
	readonly modelId: string;
	readonly text: string;
	readonly idempotencyKey: string;
	readonly variant?: string;
	readonly speed?: "standard" | "fast" | "ultrafast";
	readonly alternateContext?: boolean;
};

/**
 * Starts or continues the chat's side conversation. The parent row is only
 * read, for the snapshot the side model sees. A running parent turn is not
 * queued, stopped, or steered.
 */
export async function sendSideChatMessage(
	machines: WorkspaceMachines,
	input: SideChatSend,
) {
	const parent = await agentSessionForOwner(
		input.userId,
		input.parentSessionId,
	);
	if (!parent || parent.projectId !== input.projectId || parent.parentSessionId)
		throw new Error("Open a chat before starting a side chat.");
	const side = await ensureSideChat(parent, input.harnessId, input.modelId);
	const target = sideChatSendTarget({
		parentSessionId: parent.id,
		sideSessionId: side.id,
		sideTurnStatus: side.turnStatus,
	});
	const scope: HarnessSessionScope = {
		userId: input.userId,
		projectId: input.projectId,
		sessionId: target.sessionId,
		harnessId: input.harnessId,
		createNew: false,
	};
	const modelText = sideChatModelText(
		input.text,
		sessionItemsFromUnknown(parent.items),
	);
	if (target.queueOn === "side") {
		const queued = await queueSideTurn(input, side.id, modelText);
		if (queued === "queued")
			return { sideSessionId: side.id, view: await publicSessionView(scope) };
	}
	const sent = await Effect.runPromise(
		sendHarnessWorkspaceTask(machines, scope, {
			text: input.text,
			modelId: input.modelId,
			runtimeText: modelText,
			idempotencyKey: input.idempotencyKey,
			...(input.variant ? { variant: input.variant } : {}),
			...(input.speed ? { speed: input.speed } : {}),
			...(input.alternateContext !== undefined
				? { alternateContext: input.alternateContext }
				: {}),
		}),
	);
	return { sideSessionId: side.id, view: await withQueuedMessages(sent) };
}

/** The side column's transcript. Nothing is created until the user sends. */
export async function readSideChat(input: {
	readonly userId: string;
	readonly projectId: string;
	readonly parentSessionId: string;
	readonly harnessId: AgentProviderId;
}) {
	const parent = await agentSessionMetadataForOwner(
		input.userId,
		input.parentSessionId,
	);
	if (!parent || parent.projectId !== input.projectId || parent.parentSessionId)
		return { sessionId: null, view: null };
	const side = await sideChatForParent(input.userId, parent.id);
	if (!side) return { sessionId: null, view: null };
	return {
		sessionId: side.id,
		view: await publicSessionView({
			userId: input.userId,
			projectId: input.projectId,
			sessionId: side.id,
			harnessId: side.harness,
			createNew: false,
		}),
	};
}

async function ensureSideChat(
	parent: AgentSessionRecord,
	harnessId: AgentProviderId,
	modelId: string,
) {
	const existing = await sideChatForParent(parent.userId, parent.id);
	if (existing) return existing;
	const created = await insertAgentSession({
		userId: parent.userId,
		projectId: parent.projectId,
		workspaceId: parent.workspaceId,
		harness: harnessId,
		parentSessionId: parent.id,
		title: "Side chat",
		listedModelId: modelId,
		task: {
			prompt: "Side conversation with the user about this chat.",
			placement: "shared",
			access: "read_write",
		},
	});
	try {
		await saveSubagentSpec(parent.userId, created.id, {
			role: "writer",
			budget: sideChatBudget(),
		});
		await saveAgentTaskState(created.id, "idle");
	} catch (cause) {
		await deleteAgentSessionForOwner(parent.userId, created.id).catch(() => {});
		throw cause;
	}
	return {
		...created,
		agentRole: "writer" as const,
		agentBudget: sideChatBudget(),
		taskState: "idle" as const,
		turnStatus: "idle" as const,
	};
}

async function queueSideTurn(
	input: SideChatSend,
	sideSessionId: string,
	modelText: string,
) {
	const item = sessionItemsQueuedWithUser(
		[],
		input.text,
		input.idempotencyKey,
	).at(-1);
	if (item?.kind !== "userMessage")
		throw new Error("Side chat message is empty.");
	return queueUserMessageWhileRunning(input.userId, sideSessionId, {
		item,
		message: modelText,
		harnessId: input.harnessId,
		modelId: input.modelId,
		...(input.variant ? { variant: input.variant } : {}),
		...(input.speed ? { speed: input.speed } : {}),
		...(input.alternateContext !== undefined
			? { alternateContext: input.alternateContext }
			: {}),
	});
}
