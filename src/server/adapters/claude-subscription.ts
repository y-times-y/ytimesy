import type { ClaudeCodeGrant } from "#/domain/claude-code-grant";
import {
	CLAUDE_CODE_TURN_REQUEST_CAP,
	type ClaudeCodeProxyAuthorization,
	type ClaudeCodeUpstreamOutcome,
} from "#/domain/claude-code-proxy";
import { isClaudeCodeSessionId } from "#/domain/claude-code-stream";
import { seal, unseal } from "../auth/token-vault";
import { database } from "./database";

/** The vault binding: a sealed token copied to another user or purpose fails to open. */
const binding = (userId: string) => ({
	purpose: "claude-subscription",
	userId,
});

export type ClaudeSubscriptionStatus =
	| { readonly status: "disconnected" }
	| {
			readonly status: "connected" | "refused" | "limited";
			readonly message: string | null;
			/** Epoch ms the spent plan window resets, when Anthropic said. */
			readonly limitedUntil: number | null;
			readonly connectedAt: number;
	  };

/**
 * A token from `claude setup-token` (a long-lived OAuth token). Only its
 * shape is checked here; Anthropic decides whether it works on first use.
 */
export function normalizedSetupToken(value: string): string | null {
	const token = value.trim().replace(/^["']|["']$/g, "");
	return /^sk-ant-oat\d{2}-[A-Za-z0-9_-]{20,400}$/.test(token) ? token : null;
}

export async function saveClaudeSubscriptionToken(
	userId: string,
	token: string,
) {
	const normalized = normalizedSetupToken(token);
	if (!normalized)
		throw new Error(
			"That is not a Claude Code token. Run `claude setup-token` and paste the token it prints.",
		);
	const sealed = await seal(normalized, binding(userId));
	await database().query(
		`insert into claude_subscription(user_id,sealed_token,status,message,limited_until,connected_at,updated_at)
		 values($1,$2,'connected',null,null,now(),now())
		 on conflict(user_id) do update set sealed_token=excluded.sealed_token,status='connected',
		 message=null,limited_until=null,connected_at=now(),updated_at=now()`,
		[userId, sealed],
	);
}

export async function disconnectClaudeSubscription(userId: string) {
	await database().query("delete from claude_subscription where user_id=$1", [
		userId,
	]);
}

export async function claudeSubscriptionStatus(
	userId: string,
): Promise<ClaudeSubscriptionStatus> {
	const row = (
		await database().query<{
			status: "connected" | "refused" | "limited";
			message: string | null;
			limited_until: number | null;
			connected_at: number;
			expired: boolean;
		}>(
			`select status,message,
			 (extract(epoch from limited_until)*1000)::float8 as limited_until,
			 (extract(epoch from connected_at)*1000)::float8 as connected_at,
			 coalesce(limited_until<=now(),false) as expired
			 from claude_subscription where user_id=$1`,
			[userId],
		)
	).rows[0];
	if (!row) return { status: "disconnected" };
	// A spent window that has reset is usable again.
	const reset = row.status === "limited" && row.expired;
	return {
		status: reset ? "connected" : row.status,
		message: reset ? null : row.message,
		limitedUntil: reset ? null : (row.limited_until ?? null),
		connectedAt: row.connected_at,
	};
}

/** Whether the user can start Claude Code turns (a spent plan still lists its models). */
export async function hasClaudeSubscription(userId: string) {
	const status = await claudeSubscriptionStatus(userId);
	return status.status === "connected" || status.status === "limited";
}

/**
 * The real token, only so a turn can redact it from what it shows (a safety
 * net: the token never goes to the VM, so nothing there should print it).
 */
export async function claudeSubscriptionTokenForRedaction(userId: string) {
	const row = (
		await database().query<{ sealed_token: string }>(
			"select sealed_token from claude_subscription where user_id=$1",
			[userId],
		)
	).rows[0];
	return row ? unseal(row.sealed_token, binding(userId)) : null;
}

/**
 * The edge proxy's per-request check: the grant's turn is still running,
 * in that user's chat, on Claude Code; the request is counted against the
 * turn's cap; and the user's real token is opened.
 */
export async function authorizeClaudeCodeProxy(
	grant: ClaudeCodeGrant,
): Promise<ClaudeCodeProxyAuthorization> {
	const row = (
		await database().query<{
			requests: number | null;
			sealed_token: string;
			status: string;
		}>(
			`with turn as (
			   select t.id from api_turn t
			   where t.id=$1 and t.user_id=$2 and t.session_id=$3 and t.state='running'
			   and (t.connection_revision like 'claude-code:v1:%'
			        or t.failover->'route'->>'connectionRevision' like 'claude-code:v1:%')
			 ), counted as (
			   insert into claude_code_turn_request(turn_id,user_id,requests)
			   select id,$2,1 from turn
			   on conflict(turn_id) do update set requests=claude_code_turn_request.requests+1,updated_at=now()
			   returning requests
			 )
			 select (select requests from counted) as requests,c.sealed_token,c.status
			 from claude_subscription c where c.user_id=$2`,
			[grant.turnId, grant.userId, grant.sessionId],
		)
	).rows[0];
	if (!row) return { kind: "refused", status: 403 };
	if (row.requests === null) return { kind: "refused", status: 401 };
	if (row.status === "refused") return { kind: "refused", status: 403 };
	if (row.requests > CLAUDE_CODE_TURN_REQUEST_CAP)
		return { kind: "refused", status: 429 };
	return {
		kind: "ok",
		token: await unseal(row.sealed_token, binding(grant.userId)),
	};
}

/** Marks the subscription after Anthropic refused its token or the plan ran out. */
export async function recordClaudeCodeUpstream(
	userId: string,
	outcome: ClaudeCodeUpstreamOutcome,
) {
	if (outcome.kind === "rate-limited") return;
	await database().query(
		`update claude_subscription set status=$2,message=$3,
		 limited_until=case when $4::float8 is null then null else to_timestamp($4::float8/1000) end,
		 updated_at=now() where user_id=$1`,
		outcome.kind === "refused"
			? [
					userId,
					"refused",
					"Anthropic refused this token. Run claude setup-token again and paste the new token.",
					null,
				]
			: [
					userId,
					"limited",
					"Your Claude plan's usage is used up for now.",
					outcome.resetsAt,
				],
	);
}

export type ClaudeCodeSessionRecord = {
	readonly claudeSessionId: string;
	readonly transcriptPath: string | null;
	readonly cwd: string;
};

export async function readClaudeCodeSession(
	userId: string,
	sessionId: string,
): Promise<ClaudeCodeSessionRecord | null> {
	const row = (
		await database().query<{
			claude_session_id: string;
			transcript_path: string | null;
			cwd: string;
		}>(
			"select claude_session_id::text,transcript_path,cwd from claude_code_session where session_id=$1 and user_id=$2",
			[sessionId, userId],
		)
	).rows[0];
	return row && isClaudeCodeSessionId(row.claude_session_id)
		? {
				claudeSessionId: row.claude_session_id,
				transcriptPath: row.transcript_path,
				cwd: row.cwd,
			}
		: null;
}

export async function saveClaudeCodeSession(
	userId: string,
	sessionId: string,
	record: ClaudeCodeSessionRecord,
) {
	if (!isClaudeCodeSessionId(record.claudeSessionId))
		throw new Error("Invalid Claude Code session id.");
	await database().query(
		`insert into claude_code_session(session_id,user_id,claude_session_id,transcript_path,cwd,updated_at)
		 select id,$2,$3::uuid,$4,$5,now() from agent_session where id=$1 and user_id=$2
		 on conflict(session_id) do update set claude_session_id=excluded.claude_session_id,
		 transcript_path=excluded.transcript_path,cwd=excluded.cwd,updated_at=now()`,
		[
			sessionId,
			userId,
			record.claudeSessionId,
			record.transcriptPath,
			record.cwd,
		],
	);
}
