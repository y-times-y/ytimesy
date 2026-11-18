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

/**
 * Most messages one chat (or helper) may have waiting at once: a person's
 * queued sends and an agent's `queue` sends to it. A send past it is refused
 * with a clear error (the count is read with the insert, so a burst of
 * simultaneous sends may overshoot a little).
 */
export const QUEUED_MESSAGES_PER_CHAT_LIMIT = 50;

/**
 * Rows one model step reads from the inbox, oldest first. Only rows a step
 * can take are read (a queued send waiting for Send or the turn's end is
 * left out), so waiting messages never crowd out a released or steering row
 * behind them; when more than this are deliverable the step takes the oldest
 * ones and the next step takes the following ones, in order.
 */
export const PEER_INBOX_STEP_READ_LIMIT = 16;

/**
 * What a model reads in front of a message the person sent while its run was
 * going (Send now): it arrives between two steps, so the model is told what
 * it is. (A Claude Code run gets its own framing, claude-code-turn.ts.)
 */
export const MID_TURN_USER_NOTE =
	"The user sent this message while you were working. Take it into account before you continue; where it conflicts with your current plan, the user's message wins. Acknowledge it in one line, adjust, and carry on; do not restart.";

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
			injected.push({
				role: "user",
				content: `${MID_TURN_USER_NOTE}\n\n${row.message}`,
			});
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
