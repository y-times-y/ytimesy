import type { AgentProviderId } from "./agent-provider";
import type { SessionItem } from "./session-item";

export const SIDE_CHAT_QUESTION_MARKER = "\n\nQuestion:\n";

export const SIDE_CHAT_TURN_PREFIX =
	"SIDE CHAT. Answer the question. Read and search if needed. Do not edit files unless the user explicitly asks to apply a change.";

/**
 * Side chat is a child session VM copied from the project snapshot.
 * Submit on that copy's main lane so Codex does not share the parent's
 * checkout through `/tmp/ytimesy-side-*.json`.
 */
export function sideAgentSubmitLane(_harness: AgentProviderId): "main" {
	return "main";
}

export function sideChatTurnText(question: string): string {
	return `${SIDE_CHAT_TURN_PREFIX}${SIDE_CHAT_QUESTION_MARKER}${question}`;
}

export function visibleSideChatText(text: string): string {
	if (!text.startsWith("SIDE CHAT.")) return text;
	const index = text.indexOf(SIDE_CHAT_QUESTION_MARKER);
	if (index === -1) return text;
	return text.slice(index + SIDE_CHAT_QUESTION_MARKER.length);
}

export function itemsWithVisibleSideChatText(
	items: readonly SessionItem[],
): SessionItem[] {
	return items.map((item) => {
		if (item.kind === "userMessage") {
			return { ...item, text: visibleSideChatText(item.text) };
		}
		return item;
	});
}
