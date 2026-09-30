import { WorkspaceId } from "#/domain/ids";
import { runningCodexSessions } from "#/server/adapters/agent-sessions";
import { codexRuntimeForSession } from "./codex-runtime";
import { serviceCodexRefreshRequest } from "./codex-workspace-session";
import { machinesForAgentSession } from "./session-workspace-machines";
import type { WorkspaceMachines } from "./workspace-machines";

type RunningCodexSession = Awaited<
	ReturnType<typeof runningCodexSessions>
>[number];

const lastKeepalive = new Map<string, number>();

async function keepActiveMachinesAwake(
	machines: WorkspaceMachines,
	runtime: WorkspaceMachines,
	executorId: WorkspaceId,
	runnerId: WorkspaceId,
) {
	if (runnerId === executorId) return;
	const now = Date.now();
	for (const [id, at] of lastKeepalive)
		if (now - at > 300_000) lastKeepalive.delete(id);
	for (const [selected, id] of [
		[machines, executorId],
		[runtime, runnerId],
	] as const) {
		if (now - (lastKeepalive.get(id) ?? 0) < 60_000) continue;
		lastKeepalive.set(id, now);
		try {
			const result = await selected.exec(id, "true", 10_000);
			if (result.exitCode !== 0)
				throw new Error("The active Codex machine is unavailable.");
		} catch (cause) {
			lastKeepalive.delete(id);
			throw cause;
		}
	}
}

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
		sessions.map(async (session) => {
			const runtime = await codexRuntimeForSession(
				machinesForAgentSession(machines, session),
				session,
			);
			await keepActiveMachinesAwake(
				machines,
				runtime.machines,
				WorkspaceId(session.providerRef),
				runtime.workspaceId,
			);
			return service(runtime.machines, runtime.workspaceId, session.userId);
		}),
	);
	return {
		observed: results.filter((result) => result.status === "fulfilled").length,
		failed: results.filter((result) => result.status === "rejected").length,
	};
}
