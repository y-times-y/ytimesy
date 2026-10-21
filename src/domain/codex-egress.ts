/**
 * Codex subscription egress: an ordered list of network paths to
 * chatgpt.com/backend-api (the Workers VPC binding, then authenticated Node
 * relays on their own static IPs). A path that is blocked (a Cloudflare or
 * WAF rejection, a broken relay, no response headers in time) is skipped for
 * a cooldown; account and request errors are never treated as blocks.
 */

/** Why a path could not carry a request; never includes upstream text. */
export type CodexEgressBlock =
	| "challenge"
	| "cloudflare-block"
	| "forbidden-html"
	| "unauthorized-html"
	| "gateway-error"
	| "redirect"
	| "relay-unavailable"
	| "transport"
	| "timeout";

export const CODEX_EGRESS_BLOCKS = [
	"challenge",
	"cloudflare-block",
	"forbidden-html",
	"unauthorized-html",
	"gateway-error",
	"redirect",
	"relay-unavailable",
	"transport",
	"timeout",
] as const satisfies readonly CodexEgressBlock[];

/** Path ids are configuration names, never URLs: `vpc`, `direct`, `relay-1`... */
export const CODEX_EGRESS_PATH_ID = /^(vpc|direct|relay-[1-8])$/;
export const MAX_CODEX_RELAYS = 8;
export const CODEX_EGRESS_COOLDOWN_MS = 5 * 60_000;

/** Setting names of relays 2..8; relay 1 is YTIMESY_CODEX_RELAY_URL/_SECRET. */
export const codexRelaySettingNames = Array.from(
	{ length: MAX_CODEX_RELAYS - 1 },
	(_, index) => [
		`YTIMESY_CODEX_RELAY_URL_${index + 2}`,
		`YTIMESY_CODEX_RELAY_SECRET_${index + 2}`,
	],
).flat();

/** A deploy-time check: each relay needs its URL and a signing key of 32+ characters. */
export function codexRelaySettingsProblem(
	env: Readonly<Record<string, string | undefined>>,
): string | null {
	for (let index = 1; index <= MAX_CODEX_RELAYS; index++) {
		const suffix = index === 1 ? "" : `_${index}`;
		const url = env[`YTIMESY_CODEX_RELAY_URL${suffix}`];
		const secret = env[`YTIMESY_CODEX_RELAY_SECRET${suffix}`];
		if (Boolean(url) !== Boolean(secret))
			return `Subscription relay ${index} URL and signing key must be configured together.`;
		if (secret && secret.length < 32)
			return `Subscription relay ${index} signing key is invalid.`;
	}
	return null;
}

function parsesAsJson(text: string) {
	if (!/^\s*[[{]/.test(text)) return false;
	try {
		JSON.parse(text);
		return true;
	} catch {
		return false;
	}
}

/**
 * Classifies a non-2xx response that came straight from chatgpt.com (VPC or
 * direct egress). JSON errors are the account's or the request's (401
 * token_expired, 429 limits, 4xx validation) and must reach the caller; HTML or
 * empty rejections, Cloudflare challenges and edge 5xx pages are the path's.
 */
export function upstreamEgressBlock(response: {
	status: number;
	headers: Headers;
	text: string;
}): CodexEgressBlock | null {
	const { status, headers, text } = response;
	if (status < 300 || status === 429) return null;
	if (headers.has("cf-mitigated")) return "challenge";
	if (status < 400) return "redirect";
	if (parsesAsJson(text)) return null;
	if (/error code:?\s*10(?:0\d|1\d|20)\b/i.test(text))
		return "cloudflare-block";
	if (status === 403) return "forbidden-html";
	// An empty 401 is the revoked-token answer the refresh path already handled.
	if (status === 401) return text.trim() ? "unauthorized-html" : null;
	if (status >= 500) return "gateway-error";
	return null;
}

/**
 * Classifies a non-2xx answer from our own relay route. The relay reports a
 * blocked upstream as `subscription_egress_blocked`; a reply that is not the
 * relay's JSON (bad signature, missing key, another service at that URL)
 * means the relay itself cannot carry requests.
 */
export function relayEgressBlock(response: {
	status: number;
	text: string;
}): CodexEgressBlock | null {
	if (response.status < 300) return null;
	if (response.status < 400) return "redirect";
	let type: unknown;
	try {
		type = (JSON.parse(response.text) as { error?: { type?: unknown } }).error
			?.type;
	} catch {
		return "relay-unavailable";
	}
	if (type === "subscription_egress_blocked") return "forbidden-html";
	if (type === "subscription_transport_error") return "transport";
	if (type === "subscription_upstream_error" || type === "usage_limit_reached")
		return null;
	return "relay-unavailable";
}

/**
 * Per-isolate memory of blocked paths. Healthy paths keep their configured
 * order; paths in cooldown follow as a last resort, soonest-expiring first,
 * so a request is never refused while some path might still work.
 */
export class CodexEgressHealth {
	private readonly blocked = new Map<
		string,
		{ until: number; reason: CodexEgressBlock }
	>();
	constructor(
		private readonly cooldownMs = CODEX_EGRESS_COOLDOWN_MS,
		private readonly now = () => Date.now(),
	) {}

	order<T extends { id: string }>(paths: readonly T[]): T[] {
		const at = this.now();
		const healthy = paths.filter(
			(path) => (this.blocked.get(path.id)?.until ?? 0) <= at,
		);
		const cooling = paths
			.filter((path) => (this.blocked.get(path.id)?.until ?? 0) > at)
			.sort(
				(a, b) =>
					(this.blocked.get(a.id)?.until ?? 0) -
					(this.blocked.get(b.id)?.until ?? 0),
			);
		return [...healthy, ...cooling];
	}

	/** True when the path was not already blocked (a new incident). */
	markBlocked(id: string, reason: CodexEgressBlock) {
		const fresh = (this.blocked.get(id)?.until ?? 0) <= this.now();
		this.blocked.set(id, { until: this.now() + this.cooldownMs, reason });
		return fresh;
	}

	/** True when a previously blocked path carried a request again. */
	markHealthy(id: string) {
		return this.blocked.delete(id);
	}

	reset() {
		this.blocked.clear();
	}

	snapshot() {
		const at = this.now();
		return Object.fromEntries(
			[...this.blocked].map(([id, row]) => [
				id,
				{ reason: row.reason, coolingMs: Math.max(0, row.until - at) },
			]),
		);
	}
}
