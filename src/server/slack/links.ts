import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type { SlackMessage } from "#/domain/slack";
import { agentSessionForOwner } from "../adapters/agent-sessions";
import { database } from "../adapters/database";
import { serverConfig } from "../config";

export const linkSelection = z.object({
	token: z.string().regex(/^[a-f0-9]{64}$/),
	sessionId: z.string().uuid(),
});
export const tokenHash = (token: string) =>
	createHash("sha256").update(token).digest("hex");

export async function createSlackLink(message: SlackMessage) {
	const token = randomBytes(32).toString("hex");
	await database().query(
		`insert into slack_link_request(token_hash,installation_id,thread_id,slack_user_id,expires_at)
		values($1,$2,$3,$4,now()+interval '15 minutes')`,
		[
			tokenHash(token),
			message.installationId,
			message.threadId,
			message.slackUserId,
		],
	);
	return `${serverConfig().APP_URL}/integrations/slack?token=${token}`;
}

export async function slackLinkChoices(userId: string) {
	const result = await database().query(
		`select s.id,s.title,p.full_name,p.name from agent_session s join project p on p.id=s.project_id
		where s.user_id=$1 and p.user_id=$1 and s.parent_session_id is null and s.listed_model_id is not null and s.harness <> 'opencode'
		order by s.updated_at desc limit 100`,
		[userId],
	);
	return result.rows as {
		id: string;
		title: string;
		full_name: string;
		name: string | null;
	}[];
}

/** One-time link is delivered privately to the Slack author; confirmation requires an owned chat. */
export async function confirmSlackLink(
	userId: string,
	token: string,
	sessionId: string,
) {
	const session = await agentSessionForOwner(userId, sessionId);
	if (
		!session?.listedModelId ||
		session.parentSessionId ||
		session.harness === "opencode"
	)
		throw new Response("Select an existing chat with a configured model.", {
			status: 400,
		});
	const client = await database().connect();
	try {
		await client.query("begin");
		const request = await client.query(
			`delete from slack_link_request where token_hash=$1 and expires_at>now() returning *`,
			[tokenHash(token)],
		);
		const link = request.rows[0];
		if (!link)
			throw new Response(
				"This Slack link expired or was already used. Mention ytimesy again.",
				{ status: 410 },
			);
		const existing = await client.query(
			`select user_id,slack_user_id from slack_thread where installation_id=$1 and thread_id=$2 for update`,
			[link.installation_id, link.thread_id],
		);
		if (existing.rows.length)
			throw new Response(
				"This thread is already linked. Disconnect it in Slack first.",
				{ status: 409 },
			);
		await client.query(
			`insert into slack_thread(installation_id,thread_id,slack_user_id,user_id,session_id) values($1,$2,$3,$4,$5)`,
			[
				link.installation_id,
				link.thread_id,
				link.slack_user_id,
				userId,
				session.id,
			],
		);
		await client.query("commit");
		return { title: session.title };
	} catch (error) {
		await client.query("rollback");
		throw error;
	} finally {
		client.release();
	}
}
