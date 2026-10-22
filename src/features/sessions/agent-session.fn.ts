import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { Effect } from "effect";
import { z } from "zod";
import {
	type AgentProviderId,
	DEFAULT_COMPOSER_HARNESS_ID,
	parseRuntimeId as parseHarnessId,
} from "#/domain/agent-provider";
import { chatsFromAgentSessions } from "#/domain/agent-session";
import { HELPER_MESSAGE_MAX, parseSteering } from "#/domain/agent-steering";
import { agentTaskTree } from "#/domain/agent-task";
import {
	type AgentTaskActivity,
	childTaskPublicItems,
} from "#/domain/child-task-activity";
import { publicRecoveryFailure } from "#/domain/conversation-recovery-failure";
import { publicFailureMessage } from "#/domain/project-workspace";
import {
	type SessionTurnStatus,
	sessionItemsFromUnknown,
} from "#/domain/session-item";
import type { ChatWaitingOn } from "#/domain/sidebar-chats";
import { subagentTaskViews } from "#/domain/subagent-tree";
import { startAfterResponse } from "#/server/adapters/after-response";
import {
	agentSessionForOwner,
	descendantAgentSessions,
	listSidebarAgentSessions,
} from "#/server/adapters/agent-sessions";
import { FreestyleWorkspaceMachinesLive } from "#/server/adapters/freestyle/live";
import { pendingSteeringMessages } from "#/server/adapters/server-peer-inbox";
import { requireUser } from "#/server/auth/auth";
import { requireSameOrigin } from "#/server/http";
import { relayConversationDeliveriesOnce } from "#/server/jobs/conversation-delivery";
import { withPublicFailure } from "#/server/public-failure";
import {
	deleteAgentSessionMachine,
	openAgentSession,
} from "#/server/services/agent-session-machine";
import { WorkspaceMachineService } from "#/server/services/capabilities";
import type { WorkspaceMachines } from "#/server/services/workspace-machines";

type PublicAgentChat = {
	readonly id: string;
	readonly title: string;
	readonly turnStatus: SessionTurnStatus;
	readonly listedModelId?: string | null;
	readonly harnessId?: AgentProviderId | null;
	readonly updatedAt?: string | null;
	readonly workspaceId?: string | null;
	readonly workingBranch?: string | null;
	readonly waitingOn?: ChatWaitingOn | null;
	readonly workingSince?: string | null;
};

/**
 * Runs with the workspace machines. A failure reaches the user only as
 * `publicFailure` words it; the real error is logged on the server.
 */
function runWithMachines<A>(
	operation: string,
	publicFailure: (error: unknown) => string,
	run: (machines: WorkspaceMachines) => Promise<A>,
): Promise<A> {
	return withPublicFailure(operation, publicFailure, async () =>
		run(
			await Effect.runPromise(
				WorkspaceMachineService.pipe(
					Effect.provide(FreestyleWorkspaceMachinesLive),
				),
			),
		),
	);
}

export const listProjectAgentSessions = createServerFn({ method: "GET" })
	.validator((data: { projectId?: string } | undefined) => ({
		projectId: typeof data?.projectId === "string" ? data.projectId.trim() : "",
	}))
	.handler(async ({ data }): Promise<readonly PublicAgentChat[]> => {
		if (!data.projectId) return [];
		try {
			const user = await requireUser(getRequest().headers);
			const sessions = await listSidebarAgentSessions(user.id, data.projectId);
			return chatsFromAgentSessions(sessions);
		} catch {
			return [];
		}
	});

export const startProjectAgentSession = createServerFn({ method: "POST" })
	.validator(
		(data: { projectId?: string; harnessId?: string; sessionId?: string }) => {
			const projectId = data.projectId?.trim() ?? "";
			if (!projectId) throw new Error("Select a project to start a chat.");
			return {
				projectId,
				harnessId: data.harnessId
					? parseHarnessId(data.harnessId)
					: DEFAULT_COMPOSER_HARNESS_ID,
				sessionId: data.sessionId?.trim() || undefined,
			};
		},
	)
	.handler(async ({ data }): Promise<PublicAgentChat> => {
		const user = await requireUser(getRequest().headers);
		try {
			const session = await openAgentSession({
				userId: user.id,
				projectId: data.projectId,
				harness: data.harnessId as AgentProviderId,
			});
			// A chat's first call to its conversation object creates it, which
			// takes 1-3 s on the edge; delivering the new chat's (empty) view
			// now does that while the person types, so the first send's turn
			// starts at once. Best effort: the send works the same without it.
			startAfterResponse(() => relayConversationDeliveriesOnce(session.id));
			return {
				id: session.id,
				title: session.title,
				workingBranch: session.workingBranch || session.taskBranch || null,
				turnStatus: session.turnStatus,
				listedModelId: session.listedModelId,
				harnessId: session.harness,
				updatedAt: session.updatedAt,
			};
		} catch (cause) {
			throw new Error(publicFailureMessage(cause));
		}
	});

export const listProjectAgentTasks = createServerFn({ method: "GET" })
	.validator(
		(data: { projectId?: string; rootSessionId?: string } | undefined) => ({
			projectId: data?.projectId?.trim() ?? "",
			rootSessionId: data?.rootSessionId?.trim() ?? "",
		}),
	)
	.handler(async ({ data }): Promise<readonly AgentTaskActivity[]> => {
		if (!data.projectId || !data.rootSessionId) return [];
		const user = await requireUser(getRequest().headers);
		const root = await agentSessionForOwner(user.id, data.rootSessionId);
		if (!root || root.projectId !== data.projectId || root.parentSessionId) {
			return [];
		}
		// Subagents only: rows of the retired lead/child architecture (no
		// agent role) and anything under them are not shown.
		const descendants = (
			await descendantAgentSessions(user.id, root.id)
		).filter((session) => session.agentRole);
		const byId = new Map(descendants.map((session) => [session.id, session]));
		const subagents = subagentTaskViews(
			root.id,
			[root, ...descendants],
			Date.now(),
		);
		const pending = await pendingSteeringMessages(
			descendants
				.filter((session) => session.turnStatus === "running")
				.map((session) => session.id),
		).catch(() => []);
		return agentTaskTree(root.id, descendants).map((task) => {
			const subagent = subagents.get(task.id);
			const queuedSteering = pending.flatMap((row) => {
				if (row.recipientId !== task.id) return [];
				const steering = parseSteering(row.message);
				return steering ? [{ id: row.id, ...steering }] : [];
			});
			return {
				...task,
				...(queuedSteering.length ? { queuedSteering } : {}),
				items: childTaskPublicItems(
					sessionItemsFromUnknown(byId.get(task.id)?.items),
				),
				turnStatus: byId.get(task.id)?.turnStatus ?? "idle",
				...(subagent ? { subagent } : {}),
			};
		});
	});

const helperMessageInput = z.object({
	projectId: z.uuid(),
	rootSessionId: z.uuid(),
	helperId: z.uuid(),
	requestId: z.uuid(),
	message: z.string().trim().min(1).max(HELPER_MESSAGE_MAX),
});

/** The user steers one of the chat's running helpers from the agents list. */
export const sendHelperMessage = createServerFn({ method: "POST" })
	.validator((data: unknown) => helperMessageInput.parse(data))
	.handler(async ({ data }) => {
		requireSameOrigin(getRequest());
		const user = await requireUser(getRequest().headers);
		const { sendUserMessageToHelper } = await import(
			"#/server/services/helper-steering"
		);
		return sendUserMessageToHelper({ userId: user.id, ...data });
	});

export const deleteProjectAgentSession = createServerFn({ method: "POST" })
	.validator((data: { projectId?: string; sessionId?: string }) => {
		const projectId = data.projectId?.trim() ?? "";
		const sessionId = data.sessionId?.trim() ?? "";
		if (!projectId || !sessionId) {
			throw new Error("Select a chat to delete.");
		}
		return { projectId, sessionId };
	})
	.handler(async ({ data }): Promise<{ id: string }> => {
		const user = await requireUser(getRequest().headers);
		await runWithMachines("Chat deletion", publicFailureMessage, (machines) =>
			deleteAgentSessionMachine(machines, {
				userId: user.id,
				projectId: data.projectId,
				sessionId: data.sessionId,
			}),
		);
		return { id: data.sessionId };
	});

export const getConversationRecoveryPoints = createServerFn({ method: "GET" })
	.validator((data: { projectId: string; sessionId: string }) => ({
		projectId: data.projectId,
		sessionId: data.sessionId,
	}))
	.handler(async ({ data }) => {
		const user = await requireUser(getRequest().headers);
		const { listConversationRecoveryPoints } = await import(
			"#/server/services/conversation-recovery"
		);
		return listConversationRecoveryPoints(
			user.id,
			data.projectId,
			data.sessionId,
		);
	});

export const restoreConversationPoint = createServerFn({ method: "POST" })
	.validator(
		(data: {
			projectId: string;
			sessionId: string;
			messageId: string;
			mode: "conversation" | "code" | "both" | "fork";
		}) => data,
	)
	.handler(async ({ data }) => {
		const user = await requireUser(getRequest().headers);
		const { recoverConversation } = await import(
			"#/server/services/conversation-recovery"
		);
		return runWithMachines(
			"Conversation recovery",
			(error) => publicRecoveryFailure(error, data.mode),
			(machines) => recoverConversation(machines, user.id, data),
		);
	});

const forkedChat = z.object({ projectId: z.uuid(), sessionId: z.uuid() });

/** A forked chat's VM copy: preparing, failed (with retry), or null when ready. */
export const getConversationForkStatus = createServerFn({ method: "GET" })
	.validator((data: { projectId: string; sessionId: string }) =>
		forkedChat.parse(data),
	)
	.handler(async ({ data }) => {
		const user = await requireUser(getRequest().headers);
		const { conversationForkState } = await import(
			"#/server/services/conversation-recovery"
		);
		return conversationForkState(user.id, data.projectId, data.sessionId);
	});

export const retryConversationForkFn = createServerFn({ method: "POST" })
	.validator((data: { projectId: string; sessionId: string }) =>
		forkedChat.parse(data),
	)
	.handler(async ({ data }) => {
		const user = await requireUser(getRequest().headers);
		const { retryConversationFork } = await import(
			"#/server/services/conversation-recovery"
		);
		return runWithMachines(
			"Fork retry",
			(error) => publicRecoveryFailure(error, "fork"),
			(machines) =>
				retryConversationFork(
					machines,
					user.id,
					data.projectId,
					data.sessionId,
				),
		);
	});
