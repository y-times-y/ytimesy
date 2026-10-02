import type { AgentTask } from "./agent-task";
import type { SessionItem, SessionTurnStatus } from "./session-item";

export type AgentTaskActivity = AgentTask & {
	readonly items: readonly SessionItem[];
	readonly turnStatus: SessionTurnStatus;
};

const INTERNAL_EVENT_PREFIX = "\u2063ytimesy-child-event:";
export function childTaskEventQueueText(eventId: string) {
	return `${INTERNAL_EVENT_PREFIX}${eventId}`;
}

export function isInternalChildTaskMessage(text: string): boolean {
	return (
		text.startsWith(INTERNAL_EVENT_PREFIX) ||
		((/^[^\n]+ (finished|failed)\. Its final summary is below:\n\n/.test(
			text,
		) ||
			/^[^\n]+ is blocked and needs your decision:\n\n/.test(text)) &&
			(text.endsWith(
				"Inspect its evidence and diff before accepting or publishing the result.",
			) ||
				text.endsWith(
					"Answer the child, escalate to the user if necessary, or revise the plan.",
				)))
	);
}

/** Old notification turns remain in storage, but are not user-authored chat. */
export function childTaskPublicItems(
	items: readonly SessionItem[],
): SessionItem[] {
	return items.filter(
		(item) =>
			(item.kind !== "userMessage" && item.kind !== "agentMessage") ||
			!isInternalChildTaskMessage(item.text),
	);
}

export function childTaskPromptId(
	task: Pick<AgentTask, "createdAt">,
	items: readonly SessionItem[],
) {
	const prompts = items.filter((item) => item.kind === "userMessage");
	const createdAt = Date.parse(task.createdAt);
	return (
		prompts
			.filter((item) => item.timing && item.timing.startedAt <= createdAt)
			.at(-1)?.id ?? prompts[0]?.id
	);
}
