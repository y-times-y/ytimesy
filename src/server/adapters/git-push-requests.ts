import type { PushAnswer } from "#/domain/push-approval";
import { database } from "./database";

/** A workspace push to a default branch the proxy refused, waiting for the user. */
export type RefusedPush = {
	id: string;
	owner: string;
	name: string;
	branch: string;
	oldId: string;
	newId: string;
};

/** A refused push with what the card and the server push need. */
export type PushRequestRecord = RefusedPush & {
	projectId: string;
	sessionId: string;
	createdAt: Date;
	/** When request_push_approval posted its card; null before. */
	requestedAt: Date | null;
	/** When the user's Push started the server's push; null before. */
	approvedAt: Date | null;
	answer: PushAnswer | null;
	answerDetail: string | null;
};

/** A refused push stays requestable this long; the agent asks right after. */
const REQUEST_HOURS = 6;

const RECORD_COLUMNS = `id, owner, name, branch, old_id as "oldId", new_id as "newId",
 project_id as "projectId", session_id as "sessionId", created_at as "createdAt",
 requested_at as "requestedAt", approved_at as "approvedAt", answer, answer_detail as "answerDetail"`;

/**
 * Rows in git_push_request: the proxy records a refused default-branch push,
 * request_push_approval posts its card, and the card's answer (the
 * server's push, a cancel, or outdated/expired) is kept on the row until the
 * chat shows it.
 */
export const gitPushRequests = {
	async recordRefused(input: {
		userId: string;
		projectId: string;
		sessionId: string;
		owner: string;
		name: string;
		branch: string;
		oldId: string;
		newId: string;
	}) {
		await database().query(
			`with expired as (
			   delete from git_push_request where user_id=$1 and created_at < now() - interval '7 days'
			 )
			 insert into git_push_request(user_id,project_id,session_id,owner,name,branch,old_id,new_id)
			 values($1,$2,$3,$4,$5,$6,$7,$8)`,
			[
				input.userId,
				input.projectId,
				input.sessionId,
				input.owner,
				input.name,
				input.branch,
				input.oldId,
				input.newId,
			],
		);
	},

	/** The newest refused push of this branch in the chat's project that no card has asked for yet. */
	async latestRefused(input: {
		userId: string;
		projectId: string;
		owner: string;
		name: string;
		branch: string;
	}): Promise<RefusedPush | null> {
		const result = await database().query<RefusedPush>(
			`select id, owner, name, branch, old_id as "oldId", new_id as "newId"
			 from git_push_request
			 where user_id=$1 and project_id=$2 and lower(owner)=lower($3) and lower(name)=lower($4)
			   and branch=$5 and answer is null and requested_at is null
			   and created_at > now() - make_interval(hours => $6)
			 order by created_at desc limit 1`,
			[
				input.userId,
				input.projectId,
				input.owner,
				input.name,
				input.branch,
				REQUEST_HOURS,
			],
		);
		return result.rows[0] ?? null;
	},

	/**
	 * The card was posted in this chat: its lifetime starts now, and its
	 * notice goes to this chat (a helper's refused push is shown by its lead).
	 */
	async markRequested(userId: string, requestId: string, sessionId: string) {
		const result = await database().query(
			"update git_push_request set requested_at=now(), session_id=$3 where id=$1 and user_id=$2 and requested_at is null returning id",
			[requestId, userId, sessionId],
		);
		return result.rows.length === 1;
	},

	async record(
		userId: string,
		requestId: string,
	): Promise<PushRequestRecord | null> {
		const result = await database().query<PushRequestRecord>(
			`select ${RECORD_COLUMNS} from git_push_request where id=$1 and user_id=$2`,
			[requestId, userId],
		);
		return result.rows[0] ?? null;
	},

	/** Whether the agent hit the same branch again since: a newer commit was refused after this one. */
	async newerRefused(userId: string, request: PushRequestRecord) {
		const result = await database().query(
			`select 1 from git_push_request
			 where user_id=$1 and project_id=$2 and lower(owner)=lower($3) and lower(name)=lower($4)
			   and branch=$5 and new_id<>$6 and created_at > $7 limit 1`,
			[
				userId,
				request.projectId,
				request.owner,
				request.name,
				request.branch,
				request.newId,
				request.createdAt,
			],
		);
		return result.rows.length > 0;
	},

	/** The user's Push starts the server's push; false when one already started or the card is answered. */
	async claimPush(userId: string, requestId: string) {
		const result = await database().query(
			"update git_push_request set approved_at=now() where id=$1 and user_id=$2 and approved_at is null and answer is null returning id",
			[requestId, userId],
		);
		return result.rows.length === 1;
	},

	/**
	 * Settles a card once: false when it was already answered (another tab's
	 * click, a concurrent status check), so only one answer ever stands.
	 */
	async answer(
		userId: string,
		requestId: string,
		answer: PushAnswer,
		detail: string,
	) {
		const result = await database().query(
			`update git_push_request set answer=$3, answer_detail=$4, answered_at=now()
			 where id=$1 and user_id=$2 and answer is null returning id`,
			[requestId, userId, answer, detail.slice(0, 300)],
		);
		return result.rows.length === 1;
	},

	/**
	 * Answered requests of a chat whose notice is not in the chat yet, each
	 * claimed once; release() hands one back when its notice was not saved.
	 */
	async claimUnnoticed(userId: string, sessionId: string) {
		const result = await database().query<PushRequestRecord>(
			`update git_push_request set noticed_at=now()
			 where user_id=$1 and session_id=$2 and answer is not null and noticed_at is null
			 returning ${RECORD_COLUMNS}`,
			[userId, sessionId],
		);
		return result.rows;
	},

	async releaseNotice(userId: string, requestId: string) {
		await database().query(
			"update git_push_request set noticed_at=null where id=$1 and user_id=$2",
			[requestId, userId],
		);
	},
};
