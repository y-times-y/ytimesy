import { Effect } from "effect";
import type { AgentSessionRecord } from "#/server/adapters/agent-sessions";
import { runningAgentSessions } from "#/server/adapters/agent-sessions";
import {
	readHarnessWorkspaceSession,
	type HarnessSessionScope,
} from "./harness-workspace-session";
import { machinesForAgentSession } from "./session-workspace-machines";
import type { WorkspaceMachines } from "./workspace-machines";

type RunningSession = Pick<
	AgentSessionRecord,
	"id" | "userId" | "projectId" | "harness" | "taskPlacement"
>;

/**
 * Re-observes turns from database state after any web or worker process loss.
 * One failed VM must not prevent the remaining active turns from advancing.
 */
export async function reconcileRunningAgentTurns(
	machines: WorkspaceMachines,
	dependencies: {
		readonly list?: () => Promise<readonly RunningSession[]>;
		readonly observe?: (
			machines: WorkspaceMachines,
			scope: HarnessSessionScope,
		) => Promise<unknown>;
	} = {},
) {
	const sessions = await (dependencies.list ?? runningAgentSessions)();
	const observe =
		dependencies.observe ??
		((selectedMachines: WorkspaceMachines, scope: HarnessSessionScope) =>
			Effect.runPromise(readHarnessWorkspaceSession(selectedMachines, scope)));
	const results = await Promise.allSettled(
		sessions.map((session) =>
			observe(machinesForAgentSession(machines, session), {
				userId: session.userId,
				projectId: session.projectId,
				sessionId: session.id,
				harnessId: session.harness,
				createNew: false,
			}),
		),
	);
	return {
		observed: results.filter((result) => result.status === "fulfilled").length,
		failed: results.filter((result) => result.status === "rejected").length,
	};
}
