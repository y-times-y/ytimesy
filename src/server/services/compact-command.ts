import type { ModelMessage } from "ai";
import { isCompactCommandText } from "#/domain/slash-command";
import { messageText } from "./api-agent-context";

/**
 * What the model reads in place of a /compact message. The turn compacts the
 * context before this model call (compactNow), so this is one cheap reply on
 * the compacted history; the chat still shows the user's "/compact".
 */
export const COMPACT_INSTRUCTION =
	"The user ran /compact: the conversation context was compacted before this message. Reply with one short sentence confirming it, and state what you were working on. Do not use tools or start any work.";

/** Whether the history ends with the user's /compact message. */
export function endsWithCompactCommand(messages: readonly ModelMessage[]) {
	const last = messages.at(-1);
	return last?.role === "user" && isCompactCommandText(messageText(last));
}

/** The /compact message replaced by its instruction; any other history is returned as it is. */
export function withCompactInstruction(
	messages: ModelMessage[],
): ModelMessage[] {
	if (!endsWithCompactCommand(messages)) return messages;
	return [
		...messages.slice(0, -1),
		{ role: "user", content: COMPACT_INSTRUCTION },
	];
}
