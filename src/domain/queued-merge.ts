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

/** The line in front of several waiting messages read as one turn. */
export const MERGED_QUEUE_NOTE = (count: number) =>
	`The user sent ${count} messages while you were busy. Answer them together in one reply, in order; where they conflict, the later one wins.`;

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
		modelText: `${MERGED_QUEUE_NOTE(parts.length)}\n\n${parts
			.map(
				(part, index) =>
					`Message ${index + 1} of ${parts.length}:\n${part.message}`,
			)
			.join("\n\n")}`,
	};
}
