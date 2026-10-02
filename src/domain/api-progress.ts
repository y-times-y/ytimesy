import type { ApiAgentEvent } from "./api-agent-event";
import { SessionItemId } from "./ids";
import type { SessionItem } from "./session-item";

export function recordedContextUsage(items: readonly SessionItem[]) {
	for (let index = items.length - 1; index >= 0; index--) {
		const item = items[index];
		if (item.kind === "userMessage" && item.contextUsage)
			return item.contextUsage;
	}
	return undefined;
}

export function applyApiProgress(
	items: readonly SessionItem[],
	turnId: string,
	event: ApiAgentEvent,
): SessionItem[] {
	if (event.type === "usage" || event.type === "context") {
		let index = items.length - 1;
		while (index >= 0 && items[index].kind !== "userMessage") index--;
		return items.map((item, position) =>
			position === index && item.kind === "userMessage"
				? event.type === "usage"
					? { ...item, apiUsage: event.usage }
					: {
							...item,
							contextUsage: {
								...item.contextUsage,
								...(event.context ? { context: event.context } : {}),
								compacting: event.compacting,
							},
						}
				: item,
		);
	}
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
			status:
				event.type === "tool-call"
					? "inProgress"
					: event.failed
						? "failed"
						: "completed",
		};
	else return [...items];
	return existing
		? items.map((item) => (item.id === id ? next : item))
		: [...items, next];
}
