import { WorkspaceId } from "#/domain/ids";
import { runningCodexSessions } from "#/server/adapters/agent-sessions";
import { serviceCodexRefreshRequest } from "./codex-workspace-session";
import { machinesForAgentSession } from "./session-workspace-machines";
import type { WorkspaceMachines } from "./workspace-machines";

type RunningCodexSession = Awaited<ReturnType<typeof runningCodexSessions>>[number];

/** Keeps subscription refresh independent of slower task-tool reconciliation. */
export async function reconcileCodexRefreshRequests(
	machines: WorkspaceMachines,
	dependencies: {
		readonly list?: () => Promise<readonly RunningCodexSession[]>;
		readonly service?: (
			machines: WorkspaceMachines,
			workspaceId: WorkspaceId,
			userId: string,
		) => Promise<void>;
	} = {},
) {
	const sessions = await (dependencies.list ?? runningCodexSessions)();
	const service = dependencies.service ?? serviceCodexRefreshRequest;
	const results = await Promise.allSettled(
		sessions.map((session) =>
			service(
				machinesForAgentSession(machines, session),
				WorkspaceId(session.providerRef),
				session.userId,
			),
		),
	);
	return {
		observed: results.filter((result) => result.status === "fulfilled").length,
		failed: results.filter((result) => result.status === "rejected").length,
	};
}
