import type { ClaudeCodeGrant } from "#/domain/claude-code-grant";
import {
	CLAUDE_CODE_TURN_REQUEST_CAP,
	CLAUDE_CODE_UPSTREAM,
	type ClaudeCodeProxyAuthorization,
	type ClaudeCodeUpstreamOutcome,
	claudeCodeUpstreamOutcome,
} from "#/domain/claude-code-proxy";
import { isClaudeCodeSessionId } from "#/domain/claude-code-stream";
import {
	type ClaudePlanUsage,
	claudePlanUsageFromHeaders,
	claudePlanUsageFromJson,
} from "#/domain/claude-plan-usage";
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
 * shape is checked here; saving also asks Anthropic once.
 */
export function normalizedSetupToken(value: string): string | null {
	// The terminal wraps the long token; a copy picks up line breaks and
	// spaces, and a token never contains whitespace.
	const token = value.replace(/\s+/g, "").replace(/^["']|["']$/g, "");
	return /^sk-ant-oat\d{2}-[A-Za-z0-9_-]{20,400}$/.test(token) ? token : null;
}

export type SetupTokenCheck = "accepted" | "refused" | "unknown";

/**
 * One free call (token counting) with the token, sent the way Claude Code
 * sends an OAuth token through the proxy. Only a 401 rejects the token;
 * a 403 can be endpoint or model permission, not invalid credentials; a busy or unreachable Anthropic is "unknown", which must not block
 * the save. Nothing here logs the token.
 */
export async function checkClaudeSetupToken(
	token: string,
	options: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<SetupTokenCheck> {
	let response: Response;
	try {
		response = await (options.fetch ?? fetch)(
			`${CLAUDE_CODE_UPSTREAM}/v1/messages/count_tokens`,
			{
				method: "POST",
				headers: {
					authorization: `Bearer ${token}`,
					"anthropic-version": "2023-06-01",
					"anthropic-beta": "oauth-2025-04-20",
					"content-type": "application/json",
				},
				body: JSON.stringify({
					model: "claude-haiku-5-5",
					messages: [{ role: "user", content: "hi" }],
				}),
				redirect: "manual",
				signal: AbortSignal.timeout(options.timeoutMs ?? 8_000),
			},
		);
	} catch (error) {
		console.warn("Claude setup token check could not reach Anthropic.", {
			reason: error instanceof Error ? error.name : "unknown",
		});
		return "unknown";
	}
	await response.body?.cancel().catch(() => undefined);
	if (response.status === 401) return "refused";
	if (response.ok) return "accepted";
	console.warn("Claude setup token check got no answer from Anthropic.", {
		status: response.status,
	});
	return "unknown";
}

export async function saveClaudeSubscriptionToken(
	userId: string,
	token: string,
	check: { fetch?: typeof fetch; timeoutMs?: number } = {},
) {
	const normalized = normalizedSetupToken(token);
	if (!normalized)
		throw new Error(
			"That is not a Claude Code token. Run `claude setup-token` and paste the token it prints.",
		);
	if ((await checkClaudeSetupToken(normalized, check)) === "refused")
		throw new Error(
			"Anthropic refused this token. Run claude setup-token again.",
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
 * in that user's chat, and still served by Claude Code (a turn that failed
 * over to another route has no more Claude Code access); the request is
 * counted against the turn's cap; and the user's real token is opened.
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
			   and coalesce(t.failover->'route'->>'connectionRevision',t.connection_revision) like 'claude-code:v1:%'
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

/** How often a busy turn rewrites the reading; a status change writes at once. */
const PLAN_USAGE_WRITE_EVERY_SECONDS = 15;

/**
 * Keeps the plan's latest reading (from the proxy's response headers) on the
 * user's subscription row. Most of a turn's requests skip the write.
 */
export async function recordClaudePlanUsage(
	userId: string,
	usage: ClaudePlanUsage,
	/** Seconds since the last write before another is taken; 0 always writes. */
	everySeconds = PLAN_USAGE_WRITE_EVERY_SECONDS,
) {
	await database().query(
		`update claude_subscription set plan_usage=$2::jsonb,plan_usage_at=now()
		 where user_id=$1 and (plan_usage_at is null
		 or plan_usage_at <= now() - make_interval(secs => $3)
		 or plan_usage->>'status' is distinct from $2::jsonb->>'status')`,
		[userId, JSON.stringify(usage), everySeconds],
	);
}

/** How old the reading may get before opening the picker reads it again. */
export const CLAUDE_PLAN_USAGE_REFRESH_SECONDS = 5 * 60;
const PLAN_USAGE_READ_TIMEOUT_MS = 4_000;
/** One read per user at a time in this isolate; the database claim covers the rest. */
const planUsageReads = new Map<string, Promise<ClaudePlanUsage | null>>();

/**
 * The reading for the model picker. When it is missing or older than five
 * minutes, one 1-token Haiku request with the user's token reads the plan's
 * headers afresh (it uses a tiny bit of the plan). Claiming the read moves
 * plan_usage_at forward first, so every isolate waits five minutes after an
 * attempt, failed or not. On failure the last reading (or null) comes back.
 */
export function claudePlanUsageForPicker(
	userId: string,
	options: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<ClaudePlanUsage | null> {
	const running = planUsageReads.get(userId);
	if (running) return running;
	const read = readFreshClaudePlanUsage(userId, options).finally(() =>
		planUsageReads.delete(userId),
	);
	planUsageReads.set(userId, read);
	return read;
}

async function readFreshClaudePlanUsage(
	userId: string,
	options: { fetch?: typeof fetch; timeoutMs?: number },
): Promise<ClaudePlanUsage | null> {
	const claimed = (
		await database().query<{ sealed_token: string }>(
			`update claude_subscription set plan_usage_at=now()
			 where user_id=$1 and status in ('connected','limited')
			 and (plan_usage_at is null or plan_usage_at < now() - make_interval(secs => $2))
			 returning sealed_token`,
			[userId, CLAUDE_PLAN_USAGE_REFRESH_SECONDS],
		)
	).rows[0];
	if (!claimed) return readClaudePlanUsage(userId);
	let response: Response;
	try {
		const token = await unseal(claimed.sealed_token, binding(userId));
		response = await (options.fetch ?? fetch)(
			`${CLAUDE_CODE_UPSTREAM}/v1/messages`,
			{
				method: "POST",
				headers: {
					authorization: `Bearer ${token}`,
					"anthropic-version": "2023-06-01",
					"anthropic-beta": "oauth-2025-04-20",
					"content-type": "application/json",
				},
				body: JSON.stringify({
					model: "claude-haiku-5-5",
					max_tokens: 1,
					system: [
						{
							type: "text",
							text: "You are Claude Code, Anthropic's official CLI for Claude.",
						},
					],
					messages: [{ role: "user", content: "hi" }],
				}),
				redirect: "manual",
				signal: AbortSignal.timeout(
					options.timeoutMs ?? PLAN_USAGE_READ_TIMEOUT_MS,
				),
			},
		);
	} catch (error) {
		console.warn("Claude plan usage could not be read from Anthropic.", {
			reason: error instanceof Error ? error.name : "unknown",
		});
		return readClaudePlanUsage(userId);
	}
	await response.body?.cancel().catch(() => undefined);
	const outcome = claudeCodeUpstreamOutcome(response);
	// Usage is optional bookkeeping, not an authentication gate. A rejected
	// model-specific probe must not disable a previously saved connection.
	if (outcome && outcome.kind !== "refused")
		await recordClaudeCodeUpstream(userId, outcome);
	if (response.status === 401 || response.status === 403)
		console.warn("Claude usage probe denied; saved login retained.", {
			status: response.status,
			operation: "plan-usage",
		});
	const usage =
		outcome?.kind === "refused"
			? null
			: claudePlanUsageFromHeaders(response.headers, Date.now());
	if (!usage) {
		if (!outcome)
			console.warn("Claude plan usage read got no usage headers.", {
				status: response.status,
			});
		return readClaudePlanUsage(userId);
	}
	await recordClaudePlanUsage(userId, usage, 0);
	return usage;
}

/** The latest reading while Claude is connected, or null when there is none. */
export async function readClaudePlanUsage(
	userId: string,
): Promise<ClaudePlanUsage | null> {
	const row = (
		await database().query<{ plan_usage: unknown }>(
			`select plan_usage from claude_subscription
			 where user_id=$1 and status in ('connected','limited')`,
			[userId],
		)
	).rows[0];
	return claudePlanUsageFromJson(row?.plan_usage);
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
