import type { ApiAgentEvent } from "./api-agent-event";
import { SessionItemId } from "./ids";
import type { SessionItem } from "./session-item";

export function applyApiProgress(
	items: readonly SessionItem[],
	turnId: string,
	event: ApiAgentEvent,
): SessionItem[] {
	if (event.type === "finish")
		return items.map((item) =>
			item.kind === "agentMessage" ? { ...item, streaming: false } : item,
		);
	const id = SessionItemId(`${turnId}:${event.id}`);
	const existing = items.find((item) => item.id === id);
	let next: SessionItem;
	if (event.type === "text-delta")
		next = {
			kind: "agentMessage",
			id,
			text:
				(existing?.kind === "agentMessage" ? existing.text : "") + event.text,
			streaming: true,
		};
	else if (event.type === "reasoning-delta")
		next = {
			kind: "reasoning",
			id,
			summaries: [
				(existing?.kind === "reasoning" ? existing.summaries.join("") : "") +
					event.text,
			],
		};
	else if (event.type === "tool-call" || event.type === "tool-result")
		next = {
			kind: "dynamicToolCall",
			id,
			tool: event.name,
			status: event.type === "tool-call" ? "inProgress" : "completed",
		};
	else return [...items];
	return existing
		? items.map((item) => (item.id === id ? next : item))
		: [...items, next];
}
