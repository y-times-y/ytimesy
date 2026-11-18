import {
	CodexEgressUnavailable,
	CodexReconnectRequired,
	XaiSubscriptionUnavailable,
} from "./api-turn-failure";

/**
 * How the edge's model proxy tells a turn runner box that a subscription
 * route could not serve a request (docs/turn-runner-boxes.md, "Subscription
 * routes"). The edge holds the OAuth tokens and meets these failures (a
 * refresh the provider rejected, every egress path blocked); the box rebuilds
 * the SAME typed errors the Durable Object's transport throws, so the turn's
 * failure wording and failover reason are unchanged. A code and, for egress,
 * path ids and reasons cross; no token, account id or upstream body does.
 */
export const SUBSCRIPTION_ERROR_HEADER = "x-ytimesy-subscription-error";

const XAI_REASONS = [
	"reconnect",
	"not-eligible",
	"usage-limit",
	"unavailable",
] as const;

export type SubscriptionRefusal = {
	readonly code: string;
	readonly status: 403 | 503;
	readonly body: unknown;
};

/** The wire form of a transport error, or null when it is not a subscription failure. */
export function subscriptionRefusalOf(
	error: unknown,
): SubscriptionRefusal | null {
	if (error instanceof CodexReconnectRequired)
		return { code: "codex-reconnect", status: 403, body: {} };
	if (error instanceof CodexEgressUnavailable)
		return {
			code: "codex-egress",
			status: 503,
			body: {
				attempts: error.attempts.slice(0, 8).map((row) => ({
					path: String(row.path).slice(0, 32),
					reason: String(row.reason).slice(0, 32),
				})),
			},
		};
	if (error instanceof XaiSubscriptionUnavailable)
		return { code: `xai-${error.reason}`, status: 403, body: {} };
	return null;
}

/** On the box: the typed error a refusal stands for, or null for an ordinary response. */
export function subscriptionErrorOf(
	code: string | null,
	body: unknown,
): Error | null {
	if (!code) return null;
	if (code === "codex-reconnect") return new CodexReconnectRequired();
	if (code === "codex-egress") {
		const attempts = (body as { attempts?: unknown } | null)?.attempts;
		return new CodexEgressUnavailable(
			Array.isArray(attempts)
				? attempts.slice(0, 8).map((row) => ({
						path: String((row as { path?: unknown })?.path ?? "").slice(0, 32),
						reason: String((row as { reason?: unknown })?.reason ?? "").slice(
							0,
							32,
						),
					}))
				: [],
		);
	}
	const reason = XAI_REASONS.find((value) => `xai-${value}` === code);
	return reason ? new XaiSubscriptionUnavailable(reason) : null;
}
