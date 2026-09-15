import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { Effect } from "effect";
import {
	type AgentProviderId,
	DEFAULT_COMPOSER_HARNESS_ID,
} from "#/domain/agent-provider";
import { chatsFromAgentSessions } from "#/domain/agent-session";
import { publicFailureMessage } from "#/domain/project-workspace";
import type { SessionTurnStatus } from "#/domain/session-item";
import { listAgentSessions } from "#/server/adapters/agent-sessions";
import { FreestyleWorkspaceMachinesLive } from "#/server/adapters/freestyle/live";
import { requireUser } from "#/server/auth/auth";
import { parseHarnessId } from "#/server/secrets/harness-key-store";
import {
	bindAgentSessionMachine,
	deleteAgentSessionMachine,
} from "#/server/services/agent-session-machine";
import { WorkspaceMachineService } from "#/server/services/capabilities";
import type { WorkspaceMachines } from "#/server/services/workspace-machines";

export type PublicAgentChat = {
	readonly id: string;
	readonly title: string;
	readonly turnStatus: SessionTurnStatus;
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
			const bound = await runWithMachines((machines) =>
				bindAgentSessionMachine(machines, {
					userId: user.id,
					projectId: data.projectId,
					harness: data.harnessId as AgentProviderId,
					sessionId: data.sessionId,
					createNew: !data.sessionId,
				}),
			);
			return {
				id: bound.session.id,
				title: bound.session.title,
				turnStatus: bound.session.turnStatus,
			};
		} catch (cause) {
			throw new Error(publicFailureMessage(cause));
		}
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
