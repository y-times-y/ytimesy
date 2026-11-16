import { API_MODEL_LIST } from "./api-model-list";
import { DIRECT_MODEL_ENDPOINTS } from "./browse-models";
import type { ConnectedModel } from "./model-connection";

/**
 * A user's xAI SuperGrok (or X Premium) subscription, signed in with xAI's
 * device-code OAuth, used as a model connection: chats run on Grok through
 * api.x.ai with the user's own bearer token and draw from their plan.
 * Off unless YTIMESY_XAI_SUBSCRIPTION_ENABLED=1; when off nothing shows.
 */
export function xaiSubscriptionEnabled(
	env: { readonly YTIMESY_XAI_SUBSCRIPTION_ENABLED?: string } = process.env,
): boolean {
	return env.YTIMESY_XAI_SUBSCRIPTION_ENABLED === "1";
}

/** How the chat and the picker name the subscription's connection. */
export const XAI_SUBSCRIPTION_LABEL = "Grok plan";

/** The xAI API the subscription's token calls; already an official edge endpoint. */
export const XAI_API_BASE_URL = DIRECT_MODEL_ENDPOINTS["x-ai"] as string;

/** Where the connection stands: usable, or waiting for the user. */
export type XaiSubscriptionStatus = "ready" | "reconnect" | "not-eligible";

/** What Settings and the first run show. */
export type XaiSubscriptionView =
	| { readonly status: "disconnected" }
	| {
			readonly status: XaiSubscriptionStatus;
			readonly connectionId: string;
			readonly modelCount: number;
	  };

/**
 * What Settings says about a connection that is not ready. Only a rejected
 * sign-in asks the user to sign in again: a refusal is retried on its own
 * (xaiConnectionMayServe), so it reads as a passing state.
 */
export function xaiSubscriptionMessage(
	status: Exclude<XaiSubscriptionStatus, "ready">,
): string {
	return status === "reconnect"
		? "Your Grok sign-in expired. Reconnect it in Settings > Agents."
		: "xAI refused the last Grok request. Your next Grok turn tries the plan again.";
}

/** Whether Settings should offer sign-in for this status (a refusal is retried instead). */
export function xaiSubscriptionNeedsSignIn(
	status: XaiSubscriptionStatus | "disconnected",
): boolean {
	return status === "disconnected" || status === "reconnect";
}

/**
 * The catalog's Grok models, as the xAI API names them: what the connection
 * offers when xAI's model list is unavailable to the subscription's token.
 */
export function catalogXaiModels(): ConnectedModel[] {
	return API_MODEL_LIST.flatMap((entry) =>
		entry.author === "x-ai" && entry.directId
			? [
					{
						id: entry.directId,
						label: entry.label,
						toolStreamingVerified: false,
					},
				]
			: [],
	);
}

/**
 * The models the subscription offers: xAI's own list when it names any
 * catalog Grok model, else the catalog's Grok models.
 */
export function xaiSubscriptionModels(
	discovered: readonly ConnectedModel[] | null,
): ConnectedModel[] {
	const catalog = catalogXaiModels();
	const listed = new Set(catalog.map((model) => model.id));
	return discovered?.some((model) => listed.has(model.id))
		? [...discovered]
		: catalog;
}

/**
 * How long a refusal stands before the connection is tried again. A refusal
 * is a reading of one request, not a verdict on the plan: xAI also answers 403
 * for limits and edge blocks. Without this, one 403 hid a working Grok plan
 * for a day (production, 2026-11-07) while every turn quietly ran elsewhere.
 */
export const XAI_REFUSAL_COOLDOWN_MS = 10 * 60_000;

/** Whether a connection in `status`, last changed `ageMs` ago, may serve a request. */
export function xaiConnectionMayServe(
	status: XaiSubscriptionStatus,
	ageMs: number,
): boolean {
	return (
		status === "ready" ||
		(status === "not-eligible" && ageMs >= XAI_REFUSAL_COOLDOWN_MS)
	);
}

/**
 * A spent plan, in xAI's words. xAI answers an exhausted plan with a 403
 * that also names the subscription, e.g. "You have either run out of
 * available resources or do not have an active Grok subscription. Manage
 * your subscription at https://grok.com/?_s=usage or subscribe at
 * https://grok.com/supergrok." (Hermes #26847), or
 * "personal-team-blocked:spending-limit" with "You have run out of credits
 * or need a Grok subscription" (CLIProxyAPI #5335). So limit wording is read
 * first: such a 403 is a usage limit, never a verdict on the plan.
 */
const LIMIT_WORDING =
	/run out|ran out|out of (?:available )?(?:resources|credits?|usage|quota)|spending[- ]?limit|usage[- ]limit|rate[- ]?limit|\blimit(?:s|ed)?\b|quota|exhaust|exceed|too many requests|add credits/i;

/** An explicit refusal of the plan itself (it does not include Grok here). */
const PLAN_REFUSAL =
	/not (?:eligible|entitled)|(?:does not|doesn't|do not|don't) (?:include|have (?:an? )?(?:active )?(?:grok |supergrok )?(?:subscription|access))|no (?:active )?(?:grok |supergrok )?subscription|subscription (?:is )?(?:required|inactive|expired|cancell?ed)|requires? (?:an? )?(?:active )?(?:supergrok|grok|x premium|premium)/i;

export type XaiForbiddenVerdict =
	| "usage-limit"
	| "not-eligible"
	| "unavailable";

/**
 * What a 403's body says: "usage-limit" when it speaks of a limit, credits
 * or resources (checked first, since xAI's limit text also names the
 * subscription); "not-eligible" only for an explicit refusal of the plan;
 * anything else (an edge block, an empty body) is "unavailable". Only
 * "not-eligible" is recorded on the connection.
 */
export function xaiForbiddenVerdict(body: string): XaiForbiddenVerdict {
	if (LIMIT_WORDING.test(body)) return "usage-limit";
	return PLAN_REFUSAL.test(body) ? "not-eligible" : "unavailable";
}

/**
 * OAuth errors (RFC 6749 §5.2) that end a sign-in: the refresh token is
 * spent, revoked or unknown (xAI: `invalid_grant`, "Refresh token has been
 * revoked" / "Invalid or unknown refresh token"), or the client is refused.
 * Anything else from the token endpoint may pass and is retried.
 */
const DEFINITIVE_OAUTH_ERRORS = new Set([
	"invalid_grant",
	"invalid_client",
	"unauthorized_client",
]);

/** Whether a failed refresh means the user must sign in again. */
export function xaiRefreshRejected(status: number, body: string): boolean {
	if (status !== 400 && status !== 401) return false;
	try {
		const parsed = JSON.parse(body) as { error?: unknown };
		return (
			typeof parsed.error === "string" &&
			DEFINITIVE_OAUTH_ERRORS.has(parsed.error)
		);
	} catch {
		return false;
	}
}

/**
 * A response body for the logs: one line, bounded, with anything shaped like
 * a bearer token or JWT removed (xAI's error bodies carry none, but a log
 * must not depend on that).
 */
export function xaiLogSnippet(body: string, limit = 300): string {
	return body
		.replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
		.replace(/\beyJ[\w-]+\.[\w-]+(?:\.[\w-]*)?/g, "[jwt]")
		.replace(
			/"(access_token|refresh_token|id_token)"\s*:\s*"[^"]*"/g,
			'"$1":"[redacted]"',
		)
		.replace(/\s+/g, " ")
		.slice(0, limit);
}
