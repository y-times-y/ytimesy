import {
	ENVIRONMENT_SETUP_TITLE,
	PREVIOUS_SETUP_TITLES,
} from "#/domain/environment-setup";
import { UNTITLED_SESSION_TITLE } from "#/domain/session-item";
import { database } from "./database";

/**
 * Marks a root chat as an environment-setup chat and titles it, on its first
 * send only: the chat must still be untitled or carry the title that send
 * just claimed, so a later message never relabels a working chat.
 */
export async function markEnvironmentSetupChat(
	userId: string,
	sessionId: string,
	claimedTitle: string,
) {
	const result = await database().query(
		`update agent_session set environment_setup=true, title=$3
		 where user_id=$1 and id=$2 and parent_session_id is null
		 and (environment_setup or title in ($4, $5) or title = any($6::text[]))`,
		[
			userId,
			sessionId,
			ENVIRONMENT_SETUP_TITLE,
			UNTITLED_SESSION_TITLE,
			claimedTitle,
			[...PREVIOUS_SETUP_TITLES],
		],
	);
	return (result.rowCount ?? 0) > 0;
}

/** Whether a chat was started to set up the environment (it never publishes). */
export async function isEnvironmentSetupChat(
	userId: string,
	sessionId: string,
): Promise<boolean> {
	const result = await database().query<{ environment_setup: boolean }>(
		"select environment_setup from agent_session where user_id=$1 and id=$2",
		[userId, sessionId],
	);
	return result.rows[0]?.environment_setup === true;
}

/**
 * The project's setup chat other than `exceptSessionId`, oldest first: a new
 * project's setup runs once, so a second start opens this one instead.
 */
export async function otherProjectSetupChat(
	userId: string,
	projectId: string,
	exceptSessionId: string | null,
): Promise<string | null> {
	const result = await database().query<{ id: string }>(
		`select id from agent_session where user_id=$1 and project_id=$2
		 and environment_setup and parent_session_id is null
		 and ($3::uuid is null or id<>$3::uuid)
		 order by created_at limit 1`,
		[userId, projectId, exceptSessionId],
	);
	return result.rows[0]?.id ?? null;
}
