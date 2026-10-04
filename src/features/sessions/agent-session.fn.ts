import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { Effect } from "effect";
import {
	type AgentProviderId,
	DEFAULT_COMPOSER_HARNESS_ID,
	parseRuntimeId as parseHarnessId,
} from "#/domain/agent-provider";
import { chatsFromAgentSessions } from "#/domain/agent-session";
import {
	type AgentTaskAccess,
	type AgentTaskExecution,
	type AgentTaskPlacement,
	agentTaskTree,
} from "#/domain/agent-task";
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
	editAgentTaskDraft,
	openAgentSession,
	openAgentTask,
} from "#/server/services/agent-session-machine";
import { WorkspaceMachineService } from "#/server/services/capabilities";
import {
	requestAgentTaskWrapUp,
	startPreparedAgentTask,
} from "#/server/services/harness-workspace-session";
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

function runEffectWithMachines<A, E>(
	run: (machines: WorkspaceMachines) => Effect.Effect<A, E>,
): Promise<A> {
	return Effect.runPromise(
		Effect.gen(function* () {
			const machines = yield* WorkspaceMachineService;
			return yield* run(machines);
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
		if (data.harnessId === "opencode") {
			throw new Error("This runtime is no longer offered for new chats.");
		}
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
		return agentTaskTree(
			root.id,
			descendants.filter((session) => session.title !== "Side chat"),
		).map((task) => ({
			...task,
			items: childTaskPublicItems(
				sessionItemsFromUnknown(byId.get(task.id)?.items),
			),
			turnStatus: byId.get(task.id)?.turnStatus ?? "idle",
		}));
	});

type TaskDraftInput = {
	projectId?: string;
	parentSessionId?: string;
	title?: string;
	prompt?: string;
	modelId?: string;
	harnessId?: string;
	placement?: AgentTaskPlacement;
	access?: AgentTaskAccess;
	execution?: AgentTaskExecution;
	dependsOnSessionId?: string | null;
};

function parseAgentTaskDraftInput(data: TaskDraftInput) {
	const projectId = data.projectId?.trim() ?? "";
	const parentSessionId = data.parentSessionId?.trim() ?? "";
	const prompt = data.prompt?.trim() ?? "";
	const title = data.title?.trim() || prompt.slice(0, 80);
	const modelId = data.modelId?.trim() ?? "";
	if (!projectId || !parentSessionId || !prompt || !modelId) {
		throw new Error(
			"A parent, prompt, and model are required to draft a task.",
		);
	}
	if (title.toLowerCase() === "side chat") {
		throw new Error("Choose a different task title.");
	}
	return {
		projectId,
		parentSessionId,
		title: title.slice(0, 120),
		prompt,
		modelId,
		placement: (data.placement === "shared"
			? "shared"
			: "fresh") as AgentTaskPlacement,
		access: (data.access === "read_only"
			? "read_only"
			: "read_write") as AgentTaskAccess,
		execution: (data.execution === "stacked"
			? "stacked"
			: "parallel") as AgentTaskExecution,
		dependsOnSessionId: data.dependsOnSessionId?.trim() || null,
		harnessId: data.harnessId
			? parseHarnessId(data.harnessId)
			: DEFAULT_COMPOSER_HARNESS_ID,
	};
}

export const createProjectAgentTaskDraft = createServerFn({ method: "POST" })
	.validator(parseAgentTaskDraftInput)
	.handler(async ({ data }): Promise<{ id: string }> => {
		const user = await requireUser(getRequest().headers);
		if (data.harnessId === "opencode") {
			throw new Error("This runtime is no longer offered for new tasks.");
		}
		const task = await openAgentTask({
			userId: user.id,
			projectId: data.projectId,
			parentSessionId: data.parentSessionId,
			title: data.title,
			harness: data.harnessId,
			modelId: data.modelId,
			prompt: data.prompt,
			placement: data.placement,
			access: data.access,
			execution: data.execution,
			dependsOnSessionId: data.dependsOnSessionId,
		});
		return { id: task.id };
	});

export const editProjectAgentTaskDraft = createServerFn({ method: "POST" })
	.validator((data: TaskDraftInput & { taskSessionId?: string }) => {
		const draft = parseAgentTaskDraftInput(data);
		const taskSessionId = data.taskSessionId?.trim() ?? "";
		if (!taskSessionId) throw new Error("Select a task draft to edit.");
		return { ...draft, taskSessionId };
	})
	.handler(async ({ data }): Promise<{ id: string }> => {
		const user = await requireUser(getRequest().headers);
		const saved = await editAgentTaskDraft({
			userId: user.id,
			projectId: data.projectId,
			taskSessionId: data.taskSessionId,
			title: data.title,
			harness: data.harnessId,
			modelId: data.modelId,
			prompt: data.prompt,
			placement: data.placement,
			access: data.access,
			execution: data.execution,
			dependsOnSessionId: data.dependsOnSessionId,
		});
		return { id: saved.id };
	});

export const startProjectAgentTask = createServerFn({ method: "POST" })
	.validator((data: { projectId?: string; taskSessionId?: string }) => {
		const projectId = data.projectId?.trim() ?? "";
		const taskSessionId = data.taskSessionId?.trim() ?? "";
		if (!projectId || !taskSessionId) {
			throw new Error("Select a task draft to start.");
		}
		return { projectId, taskSessionId };
	})
	.handler(
		async ({
			data,
		}): Promise<{
			id: string;
			machineId: string;
			placement: AgentTaskPlacement;
		}> => {
			const user = await requireUser(getRequest().headers);
			return runEffectWithMachines((machines) =>
				startPreparedAgentTask(
					machines,
					{
						userId: user.id,
						projectId: data.projectId,
						sessionId: data.taskSessionId,
						harnessId: "codex",
						createNew: false,
					},
					data.taskSessionId,
				),
			);
		},
	);

export const requestProjectAgentTaskWrapUp = createServerFn({ method: "POST" })
	.validator(
		(data: {
			projectId?: string;
			taskSessionId?: string;
			modelId?: string;
		}) => {
			const projectId = data.projectId?.trim() ?? "";
			const taskSessionId = data.taskSessionId?.trim() ?? "";
			const modelId = data.modelId?.trim() ?? "";
			if (!projectId || !taskSessionId || !modelId) {
				throw new Error("Select a task and model before requesting wrap-up.");
			}
			return { projectId, taskSessionId, modelId };
		},
	)
	.handler(async ({ data }): Promise<{ id: string }> => {
		const user = await requireUser(getRequest().headers);
		return runEffectWithMachines((machines) =>
			requestAgentTaskWrapUp(
				machines,
				{
					userId: user.id,
					projectId: data.projectId,
					sessionId: data.taskSessionId,
					harnessId: "codex",
					createNew: false,
				},
				data.taskSessionId,
				data.modelId,
			),
		);
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
