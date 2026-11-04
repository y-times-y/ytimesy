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

/** A refused push stays approvable this long; the agent pushes again right after. */
const REQUEST_HOURS = 6;
/** An approval is spent on the agent's retry, which follows within minutes. */
const APPROVAL_HOURS = 1;

/**
 * Rows in git_push_request: the proxy records a refused default-branch push,
 * request_push_approval reads it for the card, the card's Push approves it,
 * and the proxy spends the approval on that exact push, once.
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

	/** The newest refused, unapproved push of this branch in the chat's project. */
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
			   and branch=$5 and approved_at is null and used_at is null
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

	/** The user's Push on the card; false when the request is gone or already answered. */
	async approve(userId: string, requestId: string) {
		const result = await database().query(
			`update git_push_request set approved_at=now()
			 where id=$1 and user_id=$2 and approved_at is null and used_at is null
			   and created_at > now() - make_interval(hours => $3)
			 returning id`,
			[requestId, userId, REQUEST_HOURS],
		);
		return result.rows.length === 1;
	},

	/** Spends an approval for exactly this push; false when there is none. */
	async claimApproved(input: {
		userId: string;
		projectId: string;
		owner: string;
		name: string;
		branch: string;
		newId: string;
	}) {
		const result = await database().query(
			`update git_push_request set used_at=now()
			 where id = (
			   select id from git_push_request
			   where user_id=$1 and project_id=$2 and lower(owner)=lower($3) and lower(name)=lower($4)
			     and branch=$5 and new_id=$6 and used_at is null
			     and approved_at > now() - make_interval(hours => $7)
			   order by approved_at desc limit 1
			   for update skip locked
			 ) and used_at is null
			 returning id`,
			[
				input.userId,
				input.projectId,
				input.owner,
				input.name,
				input.branch,
				input.newId,
				APPROVAL_HOURS,
			],
		);
		return result.rows.length === 1;
	},
};
