import { database } from "./database";

/**
 * The interruption canary's chat (docs/interruption-monitoring.md) carries
 * agent_session.chat_role = 'canary'. It lives in the account the canary is
 * configured for, which may be a person's own, so every list, stat, crew and
 * cleanup query that reads that account's chats leaves it out with this
 * condition (`s` is the agent_session alias).
 */
export const NOT_CANARY_CHAT = "s.chat_role is distinct from 'canary'";

/** Marks the chat the canary just sent into as the canary's (idempotent). */
export async function markCanaryChat(userId: string, sessionId: string) {
	await database().query(
		`/* markCanaryChat */ update agent_session set chat_role='canary', thread_number=null
		 where id=$1 and user_id=$2 and parent_session_id is null and chat_role is null`,
		[sessionId, userId],
	);
}

/** Whether this chat is the canary's: people may read it but never post into it. */
export async function isCanaryChat(userId: string, sessionId: string) {
	const result = await database().query(
		`/* isCanaryChat */ select 1 from agent_session where id=$1 and user_id=$2 and chat_role='canary'`,
		[sessionId, userId],
	);
	return result.rows.length > 0;
}
