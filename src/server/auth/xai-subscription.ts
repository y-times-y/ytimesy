import { randomUUID } from "node:crypto";
import { z } from "zod";
import { XaiSubscriptionUnavailable } from "#/domain/api-turn-failure";
import type { ConnectedModel } from "#/domain/model-connection";
import {
	XAI_API_BASE_URL,
	XAI_SUBSCRIPTION_LABEL,
	type XaiSubscriptionStatus,
	type XaiSubscriptionView,
	xaiConnectionMayServe,
	xaiForbiddenVerdict,
	xaiLogSnippet,
	xaiRefreshRejected,
	xaiSubscriptionEnabled,
} from "#/domain/xai-subscription";
import { database } from "../adapters/database";
import { seal, unseal } from "./token-vault";
import {
	postXaiOAuth,
	XAI_OAUTH_CLIENT_ID,
	type XaiTokenResponse,
	xaiOAuthJson,
	xaiTokenExpiresAt,
	xaiTokenResponse,
} from "./xai-oauth";

/**
 * The SuperGrok subscription's OAuth tokens, sealed per user in its
 * model_connection row (never in a VM, never logged). Turns read the access
 * token at the edge; a refresh rotates the pair under the row's lock so two
 * steps never replay the same refresh token. xAI rotates the refresh token on
 * every use and rejects (and may revoke the family of) a spent one, so every
 * refresh goes through xaiSubscriptionAccessToken and is saved at once.
 * Access tokens live about 6 hours.
 */
const PURPOSE = "xai-subscription";
/** Refresh this long before expiry, so a long request never starts on a dying token. */
const REFRESH_SKEW_MS = 10 * 60_000;

const sealedTokens = z.object({
	connectionId: z.string(),
	userId: z.string(),
	accessToken: z.string().min(1),
	refreshToken: z.string().min(1),
	expiresAt: z.number(),
});
type SealedTokens = z.infer<typeof sealedTokens>;

export type XaiAccessToken = {
	readonly token: string;
	readonly expiresAt: number;
	/** The connection was refused earlier and is being tried again. */
	readonly trial?: true;
};

type Queryable = { query: ReturnType<typeof database>["query"] };

/** What was said when the status changed, for the logs (never a token). */
type TransitionDetail = {
	readonly cause: string;
	readonly httpStatus?: number;
	readonly body?: string;
};

/**
 * Records a status change and logs it with what xAI said, so the next
 * surprise in Settings can be traced to a request. Logs only when the row
 * actually changed; `onlyFrom` limits the change to rows in that status.
 */
async function recordXaiStatus(
	client: Queryable,
	userId: string,
	connectionId: string,
	status: XaiSubscriptionStatus,
	detail: TransitionDetail,
	onlyFrom?: XaiSubscriptionStatus,
) {
	const changed = (
		await client.query<{ from: XaiSubscriptionStatus }>(
			`with prior as (
				select id,status from model_connection
				where user_id=$1 and id=$2 and kind='xai-subscription'
				and status<>$3 and ($4::text is null or status=$4)
			)
			update model_connection m set status=$3,updated_at=now()
			from prior where m.id=prior.id returning prior.status as "from"`,
			[userId, connectionId, status, onlyFrom ?? null],
		)
	).rows[0];
	if (changed)
		console.warn("Grok plan connection status changed.", {
			connectionId,
			from: changed.from,
			to: status,
			cause: detail.cause,
			...(detail.httpStatus === undefined
				? {}
				: { httpStatus: detail.httpStatus }),
			...(detail.body === undefined
				? {}
				: { body: xaiLogSnippet(detail.body) }),
		});
}

/** At most the first kilobyte of a refused response, which it consumes. */
async function refusalBody(response: Response): Promise<string> {
	return response
		.text()
		.then((text) => text.slice(0, 1_000))
		.catch(() => "");
}

async function sealTokens(tokens: SealedTokens) {
	return seal(JSON.stringify(tokens), {
		purpose: PURPOSE,
		userId: tokens.userId,
	});
}

async function openTokens(
	sealed: string,
	userId: string,
	connectionId: string,
): Promise<SealedTokens> {
	const value = sealedTokens.parse(
		JSON.parse(
			// A blob sealed for another user fails authentication here.
			await unseal(sealed, { purpose: PURPOSE, userId }).catch(() => {
				throw new Error("SuperGrok credential ownership mismatch.");
			}),
		),
	);
	if (value.userId !== userId || value.connectionId !== connectionId)
		throw new Error("SuperGrok credential ownership mismatch.");
	return value;
}

/** The sealed-token JSON for a sign-in, to wait as another account (the same shape the main one has). */
export function xaiTokensJson(
	userId: string,
	connectionId: string,
	tokens: XaiTokenResponse,
): string {
	return JSON.stringify(sealedFrom(userId, connectionId, tokens));
}

function sealedFrom(
	userId: string,
	connectionId: string,
	tokens: XaiTokenResponse,
	previousRefresh?: string,
): SealedTokens {
	const refreshToken = tokens.refresh_token ?? previousRefresh;
	if (!refreshToken)
		throw new Error("xAI returned a sign-in without a refresh token.");
	return {
		connectionId,
		userId,
		accessToken: tokens.access_token,
		refreshToken,
		expiresAt: xaiTokenExpiresAt(tokens),
	};
}

type Row = {
	id: string;
	status: XaiSubscriptionStatus;
	sealed: string;
	/** Since the status last changed, by the database's clock. */
	ageMs: string;
};

const SELECT_ROW = `select id,status,sealed_credential as sealed,
	(extract(epoch from now()-updated_at)*1000)::bigint as "ageMs"
	from model_connection where user_id=$1 and id=$2 and kind='xai-subscription'`;

/**
 * The row when it may serve: ready, or refused long enough ago to try again
 * (xaiConnectionMayServe). A retried row is only a trial: its status is not
 * changed until a request says otherwise.
 */
function ready(row: Row | undefined): Row {
	if (!row) throw new Error("The SuperGrok subscription was disconnected.");
	if (!xaiConnectionMayServe(row.status, Number(row.ageMs)))
		throw new XaiSubscriptionUnavailable(
			row.status === "ready" ? "unavailable" : row.status,
		);
	return row;
}

/** A refresh xAI refused: whether the sign-in is over, and what xAI said. */
export class XaiRefreshRefused extends XaiSubscriptionUnavailable {
	constructor(
		reason: "reconnect" | "unavailable",
		readonly httpStatus: number,
		readonly body: string,
	) {
		super(reason);
	}
}

/** The refresh grant (OpenCode's and Kilo's): grant_type, refresh_token, client_id. */
export async function refreshXaiTokens(
	refreshToken: string,
): Promise<XaiTokenResponse> {
	let response: Response;
	try {
		response = await postXaiOAuth("/token", {
			grant_type: "refresh_token",
			refresh_token: refreshToken,
			client_id: XAI_OAUTH_CLIENT_ID,
		});
	} catch {
		throw new XaiSubscriptionUnavailable("unavailable");
	}
	if (!response.ok) {
		const body = await refusalBody(response);
		// Only an OAuth error that ends the grant (invalid_grant, ...) asks the
		// user to sign in again; an edge block or a 5xx is tried again later.
		const rejected = xaiRefreshRejected(response.status, body);
		console.warn("xAI refused a Grok token refresh.", {
			httpStatus: response.status,
			rejected,
			body: xaiLogSnippet(body),
		});
		throw new XaiRefreshRefused(
			rejected ? "reconnect" : "unavailable",
			response.status,
			body,
		);
	}
	try {
		return xaiTokenResponse.parse(await xaiOAuthJson(response));
	} catch {
		throw new XaiSubscriptionUnavailable("unavailable");
	}
}

/**
 * A current access token for the connection. A fresh one is read without a
 * lock; an expiring one, or the `rejected` token xAI just answered 401 to, is
 * refreshed under the row lock, keeping the connection's revision so queued
 * turns still match. When another step already replaced the rejected token,
 * its replacement is used without spending the refresh token again.
 */
export async function xaiSubscriptionAccessToken(
	userId: string,
	connectionId: string,
	rejected?: string,
): Promise<XaiAccessToken> {
	if (rejected === undefined) {
		const row = ready(
			(await database().query<Row>(SELECT_ROW, [userId, connectionId])).rows[0],
		);
		const tokens = await openTokens(row.sealed, userId, connectionId);
		if (tokens.expiresAt >= Date.now() + REFRESH_SKEW_MS)
			return {
				token: tokens.accessToken,
				expiresAt: tokens.expiresAt,
				...(row.status === "ready" ? {} : { trial: true as const }),
			};
	}
	const client = await database().connect();
	try {
		await client.query("begin");
		const row = ready(
			(
				await client.query<Row>(`${SELECT_ROW} for update`, [
					userId,
					connectionId,
				])
			).rows[0],
		);
		let tokens = await openTokens(row.sealed, userId, connectionId);
		// Another step may have refreshed while this one waited for the lock.
		if (
			tokens.accessToken === rejected ||
			tokens.expiresAt < Date.now() + REFRESH_SKEW_MS
		) {
			try {
				tokens = sealedFrom(
					userId,
					connectionId,
					await refreshXaiTokens(tokens.refreshToken),
					tokens.refreshToken,
				);
			} catch (error) {
				// A dead grant is recorded, so the UI asks for sign-in instead of
				// every step retrying it. Nothing else is: it may pass.
				if (
					error instanceof XaiSubscriptionUnavailable &&
					error.reason === "reconnect"
				) {
					await recordXaiStatus(client, userId, connectionId, "reconnect", {
						cause: "refresh rejected",
						...(error instanceof XaiRefreshRefused
							? { httpStatus: error.httpStatus, body: error.body }
							: {}),
					});
					await client.query("commit");
				}
				throw error;
			}
			// xAI has already spent the old refresh token: losing this write
			// signs the user out at the next refresh, so say so when it fails.
			try {
				await client.query(
					"update model_connection set sealed_credential=$3,updated_at=now() where user_id=$1 and id=$2 and kind='xai-subscription'",
					[userId, connectionId, await sealTokens(tokens)],
				);
				await client.query("commit");
			} catch (cause) {
				console.error("A rotated Grok sign-in could not be saved.", {
					connectionId,
					error: cause instanceof Error ? cause.message : String(cause),
				});
				throw cause;
			}
		} else await client.query("commit");
		return {
			token: tokens.accessToken,
			expiresAt: tokens.expiresAt,
			...(row.status === "ready" ? {} : { trial: true as const }),
		};
	} catch (cause) {
		await client.query("rollback").catch(() => undefined);
		throw cause;
	} finally {
		client.release();
	}
}

/**
 * The fetch every request of a SuperGrok turn goes through: the user's
 * bearer token replaces the placeholder key, and a 401 refreshes once and
 * retries. Only a refresh xAI rejects (invalid_grant) asks the user to sign
 * in again; a 401 on a token just refreshed, and any 403, fail the request
 * with XaiSubscriptionUnavailable, which moves the turn to another route.
 * A 403 that explicitly refuses the plan is recorded as not-eligible and
 * retried after a cooldown; the next request that works makes it ready.
 */
export function xaiSubscriptionFetch(
	userId: string,
	connectionId: string,
	transport: typeof globalThis.fetch,
): typeof globalThis.fetch {
	let current: XaiAccessToken | undefined;
	let recovering = false;
	const token = async (rejected?: string) => {
		if (
			rejected !== undefined ||
			!current ||
			current.expiresAt < Date.now() + REFRESH_SKEW_MS
		)
			current = await xaiSubscriptionAccessToken(
				userId,
				connectionId,
				rejected,
			);
		if (current.trial) recovering = true;
		return current.token;
	};
	return async (input, init) => {
		const send = async (bearer: string) => {
			const headers = new Headers(
				input instanceof Request ? input.headers : undefined,
			);
			new Headers(init?.headers).forEach((value, key) => {
				headers.set(key, value);
			});
			headers.set("authorization", `Bearer ${bearer}`);
			return transport(input, { ...init, headers });
		};
		const bearer = await token();
		let response = await send(bearer);
		if (response.status === 401) {
			const body = await refusalBody(response);
			// The refresh decides whether the sign-in is over: a rejected grant
			// throws "reconnect" from here and is recorded.
			const fresh = await token(bearer);
			// A body that can be sent again (the SDKs send JSON strings) is
			// retried once on the refreshed token.
			if (init?.body === undefined || typeof init.body === "string")
				response = await send(fresh);
			else {
				console.warn("xAI refused a Grok token; refreshed it.", {
					connectionId,
					body: xaiLogSnippet(body),
				});
				throw new XaiSubscriptionUnavailable("unavailable");
			}
		}
		if (response.status === 401) {
			// The grant still refreshes, so the sign-in is alive: this is not
			// the user's to fix, and nothing is recorded.
			console.warn("xAI refused a freshly refreshed Grok token.", {
				connectionId,
				body: xaiLogSnippet(await refusalBody(response)),
			});
			throw new XaiSubscriptionUnavailable("unavailable");
		}
		if (response.status === 403) {
			const body = await refusalBody(response);
			const verdict = xaiForbiddenVerdict(body);
			console.warn("xAI refused a Grok request.", {
				connectionId,
				verdict,
				body: xaiLogSnippet(body),
			});
			if (verdict === "not-eligible") {
				await recordXaiStatus(
					database(),
					userId,
					connectionId,
					"not-eligible",
					{ cause: "plan refused", httpStatus: 403, body },
					"ready",
				).catch(() => {});
				// A later request of this turn that works clears it again.
				recovering = true;
			}
			throw new XaiSubscriptionUnavailable(verdict);
		}
		// A connection tried again after a refusal works: say so.
		if (response.ok && recovering) {
			recovering = false;
			await recordXaiStatus(
				database(),
				userId,
				connectionId,
				"ready",
				{ cause: "request served", httpStatus: response.status },
				"not-eligible",
			).catch(() => {});
		}
		return response;
	};
}

/**
 * Stores a completed sign-in as the user's one SuperGrok connection. A
 * reconnect keeps the connection's id (fallback order, picker choices) and
 * gets a new revision, as replacing an API key does; its plan usage reading
 * is dropped, since the sign-in may be another account.
 */
export async function saveXaiSubscription(
	client: { query: ReturnType<typeof database>["query"] },
	userId: string,
	tokens: XaiTokenResponse,
	models: readonly ConnectedModel[],
): Promise<string> {
	const existing = (
		await client.query<{ id: string; status: XaiSubscriptionStatus }>(
			"select id,status from model_connection where user_id=$1 and kind='xai-subscription'",
			[userId],
		)
	).rows[0];
	const id = existing?.id ?? randomUUID();
	const sealed = await sealTokens(sealedFrom(userId, id, tokens));
	await client.query(
		`insert into model_connection(id,user_id,provider,label,base_url,sealed_credential,models,revision,kind,status)
		 values($1,$2,'compatible',$3,$4,$5,$6::jsonb,$7,'xai-subscription','ready')
		 on conflict (id) do update set sealed_credential=excluded.sealed_credential,
		 models=excluded.models,revision=excluded.revision,status='ready',
		 plan_usage=null,plan_usage_at=null,updated_at=now()`,
		[
			id,
			userId,
			XAI_SUBSCRIPTION_LABEL,
			XAI_API_BASE_URL,
			sealed,
			JSON.stringify(models),
			randomUUID(),
		],
	);
	// How often a user signs in again, and from which state, shows whether
	// sign-ins survive: log it (never a token).
	console.warn("Grok plan connection status changed.", {
		connectionId: id,
		from: existing?.status ?? "disconnected",
		to: "ready",
		cause: "signed in",
		...(tokens.expires_in ? { accessExpiresInS: tokens.expires_in } : {}),
	});
	return id;
}

/** What Settings shows; undefined while the feature is off. */
export async function loadXaiSubscription(
	userId: string,
): Promise<XaiSubscriptionView | undefined> {
	if (!xaiSubscriptionEnabled()) return undefined;
	const row = (
		await database().query<{
			id: string;
			status: XaiSubscriptionStatus;
			models: unknown;
		}>(
			"select id,status,models from model_connection where user_id=$1 and kind='xai-subscription'",
			[userId],
		)
	).rows[0];
	if (!row) return { status: "disconnected" };
	return {
		status: row.status,
		connectionId: row.id,
		modelCount: Array.isArray(row.models) ? row.models.length : 0,
	};
}

/** Signs out: the tokens and any pending sign-in are deleted. */
export async function disconnectXaiSubscription(userId: string) {
	await database().query(
		"delete from model_connection where user_id=$1 and kind='xai-subscription'",
		[userId],
	);
	await database().query("delete from xai_device_login where user_id=$1", [
		userId,
	]);
}
