import type { ModelMessage } from "ai";
import { parseSteering } from "./agent-steering";
import { SessionItemId } from "./ids";
import type { UserMessageItem } from "./session-item";

/** A row of a chat's peer inbox (agent_peer_inbox) a step reads. */
export type PeerInboxRow = {
	id: string;
	message: string;
	queued_send: { item: UserMessageItem; released?: boolean } | null;
};

const SETUP_CATCH_UP_PREFIX = "setup-catch-up:";
/** A setup catch-up row: a step's inbox read reports it, never injects it (setup-catch-up.ts). */
export const isSetupCatchUpInboxRow = (id: string) =>
	id.startsWith(SETUP_CATCH_UP_PREFIX);

/** A delivered steering message as its recipient's timeline item; null for other notices. */
export function steeringTimelineItem(
	inboxId: string,
	message: string,
): UserMessageItem | null {
	return parseSteering(message)
		? {
				kind: "userMessage",
				id: SessionItemId(`steer:${inboxId}`),
				text: message,
			}
		: null;
}

/**
 * What delivering the inbox's rows to a step does: the history with the
 * messages added, the timeline items they add, and the rows to accept once
 * a checkpoint has saved them. Pure: the Durable Object path runs it over its
 * own database read, a turn runner box over the edge's read (the same
 * decision either way). `delivering` is empty when nothing is deliverable.
 */
export function planPeerInjection(
	rows: readonly PeerInboxRow[],
	history: readonly ModelMessage[],
	options: {
		delivered: (messageId: string) => boolean;
		/** Only the user's queued messages Send was pressed on (a Claude Code run's hooks). */
		sentUserMessagesOnly: boolean;
	},
) {
	const catchUp = rows.some((row) => isSetupCatchUpInboxRow(row.id));
	// A queued follow-up stays editable until Send. The turn's end takes it
	// whether or not Send was pressed; this step does not.
	const delivering = rows.filter((row) =>
		options.sentUserMessagesOnly
			? Boolean(row.queued_send?.item) && row.queued_send?.released === true
			: !isSetupCatchUpInboxRow(row.id) &&
				!(row.queued_send?.item && row.queued_send.released === false),
	);
	const injected = [...history];
	const users: UserMessageItem[] = [];
	for (const row of delivering) {
		const item = row.queued_send?.item;
		if (item) {
			if (options.delivered(item.id)) continue;
			users.push(item);
			injected.push({ role: "user", content: row.message });
		} else if (
			!injected.some(
				(message) => message.role === "user" && message.content === row.message,
			)
		) {
			injected.push({ role: "user", content: row.message });
			// Steering shows in the subagent's transcript where it arrived.
			const steering = steeringTimelineItem(row.id, row.message);
			if (steering && !options.delivered(steering.id)) users.push(steering);
		}
	}
	return {
		catchUp,
		delivering: delivering.map((row) => row.id),
		injected,
		users,
	};
}
