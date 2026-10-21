import { database } from "./database";

/**
 * Server-side state behind private preview cookies (vm-edge-auth.ts): the
 * current version of each preview route's grant and the single-use nonces of
 * sign-in links. Table comments: 20261021120000_preview_grant_revocation.sql.
 */
export type PreviewGrantStore = {
	/** Binds the route to this chat and user; returns the version cookies must carry. */
	grant(input: {
		ruleId: string;
		userId: string;
		projectId: string;
		sessionId: string;
	}): Promise<number>;
	/** Records a sign-in link's nonce (and drops expired ones). */
	recordNonce(input: {
		nonce: string;
		ruleId: string;
		userId: string;
		expiresAt: Date;
	}): Promise<void>;
	/** Uses the nonce up atomically; returns the route's version, or null if unusable. */
	consumeNonce(input: {
		nonce: string;
		ruleId: string;
		userId: string;
	}): Promise<number | null>;
	/** The route's current version for this user, or null when the grant is gone. */
	version(ruleId: string, userId: string): Promise<number | null>;
	/** Invalidates every cookie for this chat's preview routes. */
	revokeScope(input: {
		userId: string;
		projectId: string;
		sessionId: string;
	}): Promise<void>;
};

const asVersion = (value: string | number | undefined) =>
	value === undefined ? null : Number(value);

export const previewGrants: PreviewGrantStore = {
	async grant(input) {
		// Same owner keeps the version (existing cookies stay valid); a new owner bumps it.
		const result = await database().query<{ version: string }>(
			`insert into preview_route_grant(rule_id,user_id,project_id,session_id) values($1,$2,$3,$4)
			 on conflict(rule_id) do update set
			  version=case when preview_route_grant.user_id=excluded.user_id then preview_route_grant.version else nextval('preview_route_grant_version') end,
			  user_id=excluded.user_id, project_id=excluded.project_id, session_id=excluded.session_id, updated_at=now()
			 returning version`,
			[input.ruleId, input.userId, input.projectId, input.sessionId],
		);
		const version = asVersion(result.rows[0]?.version);
		if (version === null)
			throw new Error("Could not record the preview grant.");
		return version;
	},
	async recordNonce(input) {
		await database().query(
			"with expired as (delete from preview_login_nonce where expires_at < now()) insert into preview_login_nonce(nonce,rule_id,user_id,expires_at) values($1,$2,$3,$4)",
			[input.nonce, input.ruleId, input.userId, input.expiresAt.toISOString()],
		);
	},
	async consumeNonce(input) {
		const result = await database().query<{ version: string }>(
			`with used as (delete from preview_login_nonce where nonce=$1 and rule_id=$2 and user_id=$3 and expires_at > now() returning rule_id,user_id)
			 select g.version from preview_route_grant g join used u on g.rule_id=u.rule_id and g.user_id=u.user_id`,
			[input.nonce, input.ruleId, input.userId],
		);
		return asVersion(result.rows[0]?.version);
	},
	async version(ruleId, userId) {
		const result = await database().query<{ version: string }>(
			"select version from preview_route_grant where rule_id=$1 and user_id=$2",
			[ruleId, userId],
		);
		return asVersion(result.rows[0]?.version);
	},
	async revokeScope(input) {
		await database().query(
			"update preview_route_grant set version=nextval('preview_route_grant_version'), updated_at=now() where user_id=$1 and project_id=$2 and session_id=$3",
			[input.userId, input.projectId, input.sessionId],
		);
	},
};
