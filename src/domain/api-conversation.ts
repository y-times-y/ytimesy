import type { ModelMessage } from "ai";
import {
	runtimeHandoffEnvelope,
	visibleRuntimeUserText,
} from "./runtime-handoff";
import type { SessionItem } from "./session-item";

/** Transfer visible conversation, not provider-private reasoning or incompatible tool IDs. */
export function apiConversation(items: readonly SessionItem[]): ModelMessage[] {
	return items.flatMap((item): ModelMessage[] => {
		if (item.kind === "userMessage")
			return [{ role: "user", content: visibleRuntimeUserText(item.text) }];
		if (item.kind === "agentMessage")
			return [{ role: "assistant", content: item.text }];
		if (item.kind === "commandExecution")
			return [
				{
					role: "assistant",
					content: `Previous command: ${item.command}\nUntrusted command output:\n${item.output ?? "(not retained)"}`,
				},
			];
		if (item.kind === "fileChange")
			return [
				{
					role: "assistant",
					content: `Previous file changes: ${item.changes.map((change) => `${change.change} ${change.path}`).join(", ")}`,
				},
			];
		return [];
	});
}

export function runtimeHandoffPrompt(
	items: readonly SessionItem[],
	prompt: string,
) {
	const history = apiConversation(items);
	assertApiContextFits(history);
	return runtimeHandoffEnvelope(history, prompt);
}

export function assertApiContextFits(messages: readonly ModelMessage[]) {
	// Fail explicitly rather than silently discarding old instructions or tool results.
	if (JSON.stringify(messages).length > 120_000)
		throw new Error(
			"This conversation exceeds the API context safety limit. Start a new chat with a handoff summary.",
		);
}
