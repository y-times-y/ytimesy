import type { ApiAgentEvent } from "../../src/domain/api-agent-event";

// Usage events are cumulative and include compaction; step metrics do not.
export function evaluationTokenUsage(events: readonly ApiAgentEvent[]) {
	for (let index = events.length - 1; index >= 0; index--) {
		const event = events[index];
		if (event.type === "usage") return event.usage;
	}
	return null;
}

export function evaluationObservedTokens(events: readonly ApiAgentEvent[]) {
	const usage = evaluationTokenUsage(events);
	if (!usage) return 0;
	if (usage.inputTokens === null || usage.outputTokens === null)
		throw new Error("Evaluation token accounting is unavailable.");
	return usage.inputTokens + usage.outputTokens;
}
