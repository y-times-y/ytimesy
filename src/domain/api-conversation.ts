import type { ModelMessage } from "ai";
import { withAttachmentNote } from "./message-attachment";
import {
	runtimeHandoffEnvelope,
	visibleRuntimeUserText,
} from "./runtime-handoff";
import type { SessionItem } from "./session-item";

/** Transfer visible conversation, not provider-private reasoning or incompatible tool IDs. */
export function apiConversation(items: readonly SessionItem[]): ModelMessage[] {
	return items.flatMap((item): ModelMessage[] => {
		if (item.kind === "userMessage")
			return [
				{
					role: "user",
					content: withAttachmentNote(
						visibleRuntimeUserText(item.text),
						item.attachments,
					),
				},
			];
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
	// Transport/storage abuse bound, not a model context limit. The model loop compacts before inference.
	if (JSON.stringify(messages).length > 8_000_000)
		throw new Error(
			"This conversation exceeds the context transport safety limit. Start a new chat with a handoff summary.",
		);
}

const requestTexts = new WeakMap<readonly SessionItem[], Set<string>>();

/**
 * Whether a user-role model message carries one of the person's own messages
 * (in any form the transcript sends it), as opposed to a runtime notice.
 */
export function isUserRequestMessage(
	items: readonly SessionItem[],
	message: ModelMessage,
): boolean {
	if (message.role !== "user") return false;
	let texts = requestTexts.get(items);
	if (!texts) {
		texts = new Set(
			items.flatMap((item) =>
				item.kind === "userMessage"
					? [
							item.text,
							visibleRuntimeUserText(item.text),
							withAttachmentNote(item.text, item.attachments),
							withAttachmentNote(
								visibleRuntimeUserText(item.text),
								item.attachments,
							),
						]
					: [],
			),
		);
		requestTexts.set(items, texts);
	}
	const text =
		typeof message.content === "string"
			? message.content
			: message.content
					.flatMap((part) => (part.type === "text" ? [part.text] : []))
					.join("\n");
	return texts.has(text);
}
