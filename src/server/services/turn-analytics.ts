import {
	type SessionTurnStatus,
	sessionItemsFromUnknown,
} from "#/domain/session-item";
import type { AgentSessionRecord } from "../adapters/agent-sessions";
import { captureServerAnalytics } from "../adapters/analytics";

export function analyticsAgentRole(
	session: Pick<AgentSessionRecord, "parentSessionId" | "taskAccess">,
): "lead" | "builder" | "reader" {
	return !session.parentSessionId
		? "lead"
		: session.taskAccess === "read_write"
			? "builder"
			: "reader";
}

export function captureTurnTransition(
	previous: AgentSessionRecord,
	status: SessionTurnStatus,
	items: unknown,
) {
	if (previous.turnStatus === status) return;
	const message = sessionItemsFromUnknown(items)
		.filter((item) => item.kind === "userMessage")
		.at(-1);
	if (!message?.timing) return;
	const startedAt = message.timing.startedAt;
	const properties = {
		runtime: previous.harness,
		role: analyticsAgentRole(previous),
	};
	if (status === "running") {
		void captureServerAnalytics(previous.userId, "turn_started", properties, {
			key: `${previous.id}:${startedAt}`,
			timestamp: new Date(startedAt),
		});
	} else if (previous.turnStatus === "running") {
		const endedAt = message.timing.completedAt;
		void captureServerAnalytics(
			previous.userId,
			"turn_finished",
			{
				...properties,
				outcome: status === "idle" ? "cancelled" : status,
				...(endedAt === undefined
					? {}
					: { duration_ms: Math.max(0, endedAt - startedAt) }),
			},
			{
				key: `${previous.id}:${startedAt}:${status}`,
				timestamp: new Date(endedAt ?? startedAt),
			},
		);
	}
}
