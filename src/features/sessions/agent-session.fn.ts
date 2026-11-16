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
import { HELPER_MESSAGE_MAX } from "#/domain/agent-steering";
import type { AgentTaskActivity } from "#/domain/child-task-activity";
import { publicRecoveryFailure } from "#/domain/conversation-recovery-failure";
import { publicFailureMessage } from "#/domain/project-workspace";
import type { SessionTurnStatus } from "#/domain/session-item";
import type { ChatWaitingOn } from "#/domain/sidebar-chats";
import { startAfterResponse } from "#/server/adapters/after-response";
import { listSidebarAgentSessions } from "#/server/adapters/agent-sessions";
import { FreestyleWorkspaceMachinesLive } from "#/server/adapters/freestyle/live";
import { requireUser } from "#/server/auth/auth";
import { requireSameOrigin } from "#/server/http";
import { relayConversationDeliveriesOnce } from "#/server/jobs/conversation-delivery";
import { withPublicFailure } from "#/server/public-failure";
import { openAgentSession } from "#/server/services/agent-session-machine";
import {
	olderHelperItems,
	projectAgentTasks,
} from "#/server/services/agent-task-activity";
import { WorkspaceMachineService } from "#/server/services/capabilities";
import { prewarmChatMachine } from "#/server/services/machine-prewarm";
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
	readonly unused?: boolean;
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

/**
 * The person started typing in an empty new chat: copy its machine now
 * (prewarmChatMachine). Answers at once; a refused or failed copy only means
 * the first turn makes it as before.
 */
export const prewarmProjectAgentSession = createServerFn({ method: "POST" })
	.validator((data: { projectId: string; sessionId: string }) => ({
		projectId: z.string().uuid().parse(data.projectId),
		sessionId: z.string().uuid().parse(data.sessionId),
	}))
	.handler(async ({ data }) => {
		requireSameOrigin(getRequest());
		const user = await requireUser(getRequest().headers);
		const copy = () =>
			runWithMachines("Machine copy", publicFailureMessage, (machines) =>
				prewarmChatMachine(machines, { ...data, userId: user.id }),
			).catch(() => undefined);
		if (!startAfterResponse(copy)) void copy();
		return { ok: true };
	});

export const listProjectAgentTasks = createServerFn({ method: "GET" })
	.validator(
		(
			data:
				| {
						projectId?: string;
						rootSessionId?: string;
						known?: Record<string, string>;
						deltas?: boolean;
						fresh?: boolean;
				  }
				| undefined,
		) => ({
			projectId: data?.projectId?.trim() ?? "",
			rootSessionId: data?.rootSessionId?.trim() ?? "",
			known: knownRevisions.catch({}).parse(data?.known ?? {}),
			deltas: data?.deltas === true,
			fresh: data?.fresh === true,
		}),
	)
	.handler(async ({ data }): Promise<readonly AgentTaskActivity[]> => {
		if (!data.projectId || !data.rootSessionId) return [];
		const user = await requireUser(getRequest().headers);
		return projectAgentTasks(
			user.id,
			data.projectId,
			data.rootSessionId,
			data.known,
			{ deltas: data.deltas, fresh: data.fresh },
		);
	});

/**
 * A helper's items before stored position `before` (the oldest its view
 * holds; a helper is read as its last page), read as the reader scrolls up.
 */
export const getOlderHelperItems = createServerFn({ method: "GET" })
	.validator((data: unknown) =>
		z
			.object({
				projectId: z.uuid(),
				helperId: z.uuid(),
				before: z.number().int().min(1).max(10_000_000),
			})
			.parse(data),
	)
	.handler(async ({ data }) => {
		const user = await requireUser(getRequest().headers);
		const page = await olderHelperItems(
			user.id,
			data.projectId,
			data.helperId,
			data.before,
		);
		if (!page) throw new Error("That agent is not part of this project.");
		return page;
	});

/** Helper transcript revisions the browser holds; anything odd is ignored. */
const knownRevisions = z
	.record(z.uuid(), z.string().regex(/^\d{1,19}$/))
	.refine((known) => Object.keys(known).length <= 200);

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
		// Archived, not deleted: Settings > Archived restores it for 30 days.
		const { archiveOwned } = await import("#/server/services/archive");
		await archiveOwned(user.id, "chat", data.sessionId);
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
