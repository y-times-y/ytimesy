import {
	childTaskPublicItems,
	isInternalChildTaskMessage,
} from "#/domain/child-task-activity";
import type { SessionDeltaChange } from "#/domain/session-delta";
import { sessionItemsFromUnknown } from "#/domain/session-item";
import type { TranscriptDelta } from "../adapters/agent-session-delta";

/**
 * The changed tail of a transcript delta as the view shows it, with the item
 * before it that the browser already has. Undefined when the rows read do
 * not tell where the tail attaches: the caller then reads the chat whole.
 */
export function sessionDeltaChange(
	found: Pick<TranscriptDelta, "fromPosition" | "tail" | "before">,
): SessionDeltaChange | undefined {
	if (found.fromPosition === null) return undefined;
	const anchorId = anchorBefore(found.before, found.fromPosition);
	if (anchorId === undefined) return undefined;
	return {
		anchorId,
		tail: childTaskPublicItems(sessionItemsFromUnknown(found.tail)),
	};
}

/**
 * The id of the nearest item before `fromPosition` that the view shows (the
 * view drops an agent's internal notifications), null when none comes before
 * (the tail starts the chat), undefined when the rows read do not tell.
 */
function anchorBefore(
	before: TranscriptDelta["before"],
	fromPosition: number,
): string | null | undefined {
	for (const row of before) {
		if (
			row.kind === "agentMessage" &&
			isInternalChildTaskMessage(row.text ?? "")
		)
			continue;
		return row.id ?? undefined;
	}
	return before.length === fromPosition ? null : undefined;
}
