import type { AgentSessionRecord } from "../adapters/agent-sessions";

export function analyticsAgentRole(
	session: Pick<AgentSessionRecord, "parentSessionId" | "taskAccess">,
): "lead" | "builder" | "reader" {
	return !session.parentSessionId
		? "lead"
		: session.taskAccess === "read_write"
			? "builder"
			: "reader";
}
