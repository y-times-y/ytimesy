import type { UserMessageItem } from "./session-item";

/**
 * Several waiting messages delivered as one turn. Each message keeps its own
 * bubble in the transcript (`items`, the earlier ones; the last message is
 * the send itself); the model reads them as one numbered request
 * (`modelText`), each with its own attachment note, so the files are the
 * union of theirs.
 */
export type MergedQueuedTurn = {
	readonly items: readonly UserMessageItem[];
	readonly modelText: string;
};

export function mergedQueuedTurn(
	parts: readonly {
		readonly item: UserMessageItem;
		/** What the model reads for the message alone. */
		readonly message: string;
	}[],
): MergedQueuedTurn | undefined {
	if (parts.length < 2) return undefined;
	return {
		items: parts.slice(0, -1).map((part) => part.item),
		modelText: parts
			.map(
				(part, index) =>
					`Message ${index + 1} of ${parts.length}:\n${part.message}`,
			)
			.join("\n\n"),
	};
}
