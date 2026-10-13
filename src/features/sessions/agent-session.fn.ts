import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { Effect } from "effect";
import {
	type AgentProviderId,
	DEFAULT_COMPOSER_HARNESS_ID,
	parseRuntimeId as parseHarnessId,
} from "#/domain/agent-provider";
import { chatsFromAgentSessions } from "#/domain/agent-session";
import { agentTaskTree } from "#/domain/agent-task";
import {
	type AgentTaskActivity,
	childTaskPublicItems,
} from "#/domain/child-task-activity";
import { publicFailureMessage } from "#/domain/project-workspace";
import {
	type SessionTurnStatus,
	sessionItemsFromUnknown,
} from "#/domain/session-item";
import {
	agentSessionForOwner,
	descendantAgentSessions,
	listAgentSessions,
} from "#/server/adapters/agent-sessions";
import { FreestyleWorkspaceMachinesLive } from "#/server/adapters/freestyle/live";
import { requireUser } from "#/server/auth/auth";
import {
	deleteAgentSessionMachine,
	openAgentSession,
} from "#/server/services/agent-session-machine";
import { WorkspaceMachineService } from "#/server/services/capabilities";
import type { WorkspaceMachines } from "#/server/services/workspace-machines";

export type PublicAgentChat = {
	readonly id: string;
	readonly title: string;
	readonly turnStatus: SessionTurnStatus;
	readonly listedModelId?: string | null;
	readonly harnessId?: AgentProviderId | null;
	readonly updatedAt?: string | null;
	readonly workspaceId?: string | null;
	readonly workingBranch?: string | null;
};

function runWithMachines<A>(
	run: (machines: WorkspaceMachines) => Promise<A>,
): Promise<A> {
	return Effect.runPromise(
		Effect.gen(function* () {
			const machines = yield* WorkspaceMachineService;
			return yield* Effect.tryPromise(() => run(machines));
		}).pipe(Effect.provide(FreestyleWorkspaceMachinesLive)),
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
			const sessions = await listAgentSessions(user.id, data.projectId);
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
		const descendants = await descendantAgentSessions(user.id, root.id);
		const byId = new Map(descendants.map((session) => [session.id, session]));
		return agentTaskTree(root.id, descendants).map((task) => ({
			...task,
			items: childTaskPublicItems(
				sessionItemsFromUnknown(byId.get(task.id)?.items),
			),
			turnStatus: byId.get(task.id)?.turnStatus ?? "idle",
		}));
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
		await runWithMachines((machines) =>
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
		return runWithMachines((machines) =>
			recoverConversation(machines, user.id, data),
		);
	});
