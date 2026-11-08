import {
	type ClaudeCodeGrant,
	presentedClaudeCodeGrant,
	verifyClaudeCodeGrant,
} from "./claude-code-grant";
import {
	type ClaudePlanUsage,
	claudePlanUsageFromHeaders,
} from "./claude-plan-usage";

/**
 * The edge's model proxy for Claude Code turns. The VM's Claude Code has
 * ANTHROPIC_BASE_URL pointed here and a signed per-turn grant as its OAuth
 * token. This forwards only the model API's few paths, only to
 * api.anthropic.com over HTTPS, with the user's real subscription token in
 * place of the grant. Request and response bodies stream through; nothing
 * here logs a token, a grant or a body.
 */
export const CLAUDE_CODE_PROXY_PREFIX = "/claude-code";
export const CLAUDE_CODE_UPSTREAM = "https://api.anthropic.com";
/** Model requests one turn may make (a long turn makes a few hundred). */
export const CLAUDE_CODE_TURN_REQUEST_CAP = 2_000;
const MAX_REQUEST_BYTES = 32 * 1024 * 1024;

const FORWARDED_REQUEST_HEADERS = new Set([
	"accept",
	"anthropic-beta",
	"anthropic-version",
	"content-type",
	"user-agent",
	"x-app",
	"x-claude-code-session-id",
	"x-client-request-id",
]);
const FORWARDED_RESPONSE_HEADERS = new Set([
	"content-type",
	"request-id",
	"retry-after",
	"x-should-retry",
]);

export type ClaudeCodeProxyAuthorization =
	| { readonly kind: "ok"; readonly token: string }
	/** The turn ended, the chat is not this user's, or the cap was reached. */
	| { readonly kind: "refused"; readonly status: 401 | 403 | 429 };

/** What the upstream said about the subscription, for the connection's status. */
export type ClaudeCodeUpstreamOutcome =
	| { readonly kind: "refused"; readonly status: number }
	| { readonly kind: "usage-limit"; readonly resetsAt: number | null }
	| { readonly kind: "rate-limited" };

type Route = "hello" | "messages" | "count-tokens";

/** Which allowed operation a request is, or null (refused and logged by path only). */
export function claudeCodeProxyRoute(method: string, url: URL): Route | null {
	if (!url.pathname.startsWith(`${CLAUDE_CODE_PROXY_PREFIX}/`)) return null;
	const path = url.pathname.slice(CLAUDE_CODE_PROXY_PREFIX.length);
	const query = url.search;
	if (path === "/api/hello" && (method === "HEAD" || method === "GET"))
		return "hello";
	if (method !== "POST" || (query !== "" && query !== "?beta=true"))
		return null;
	if (path === "/v1/messages") return "messages";
	if (path === "/v1/messages/count_tokens") return "count-tokens";
	return null;
}

/** A path for the log: no query, bounded, only path-safe characters. */
function loggedPath(url: URL) {
	return url.pathname.replace(/[^A-Za-z0-9/._-]/g, "_").slice(0, 120);
}

/** What a response from Anthropic says about the subscription, if anything. */
export function claudeCodeUpstreamOutcome(
	response: Response,
): ClaudeCodeUpstreamOutcome | null {
	// A permission denial is not proof that the saved login is invalid.
	if (response.status === 401)
		return { kind: "refused", status: response.status };
	if (response.status !== 429) return null;
	// A spent plan window says so in the unified rate-limit headers.
	const unified = response.headers.get("anthropic-ratelimit-unified-status");
	if (unified === "rejected") {
		const reset = Number(
			response.headers.get("anthropic-ratelimit-unified-reset"),
		);
		return {
			kind: "usage-limit",
			resetsAt: Number.isFinite(reset) && reset > 0 ? reset * 1000 : null,
		};
	}
	return { kind: "rate-limited" };
}

export async function proxyClaudeCode(
	request: Request,
	options: {
		readonly secret: string;
		/** Re-checks the turn and counts the request; returns the real token. */
		readonly authorize: (
			grant: ClaudeCodeGrant,
		) => Promise<ClaudeCodeProxyAuthorization>;
		/** Told when Anthropic refused the token or the plan is spent. */
		readonly onUpstream?: (
			grant: ClaudeCodeGrant,
			outcome: ClaudeCodeUpstreamOutcome,
		) => Promise<void>;
		/**
		 * The plan's usage from each response's headers. Called without
		 * waiting, so the response is never held up; the caller keeps any
		 * write alive (waitUntil).
		 */
		readonly onUsage?: (grant: ClaudeCodeGrant, usage: ClaudePlanUsage) => void;
		readonly upstream?: typeof fetch;
		readonly log?: (message: string, detail: Record<string, unknown>) => void;
	},
): Promise<Response> {
	const log =
		options.log ?? ((message, detail) => console.warn(message, detail));
	const url = new URL(request.url);
	const route = claudeCodeProxyRoute(request.method, url);
	if (!route) {
		log("Claude Code proxy refused an unknown path.", {
			method: request.method.slice(0, 10),
			path: loggedPath(url),
		});
		await request.body?.cancel().catch(() => undefined);
		return new Response(null, { status: 404 });
	}
	// Claude Code's reachability probe carries no credentials.
	if (route === "hello") return new Response(null, { status: 200 });
	const grant = await verifyClaudeCodeGrant(
		options.secret,
		presentedClaudeCodeGrant(request.headers),
	);
	if (!grant) {
		await request.body?.cancel().catch(() => undefined);
		return Response.json(
			{
				type: "error",
				error: {
					type: "authentication_error",
					message: "This turn's access ended.",
				},
			},
			{ status: 401 },
		);
	}
	const length = Number(request.headers.get("content-length") ?? "0");
	if (Number.isFinite(length) && length > MAX_REQUEST_BYTES) {
		await request.body?.cancel().catch(() => undefined);
		return new Response(null, { status: 413 });
	}
	let authorization: ClaudeCodeProxyAuthorization;
	try {
		authorization = await options.authorize(grant);
	} catch {
		log("Claude Code proxy authorization failed.", { stage: "authorize" });
		await request.body?.cancel().catch(() => undefined);
		return new Response(null, { status: 503 });
	}
	if (authorization.kind !== "ok") {
		await request.body?.cancel().catch(() => undefined);
		return Response.json(
			{
				type: "error",
				error: {
					type:
						authorization.status === 429
							? "rate_limit_error"
							: "permission_error",
					message:
						authorization.status === 429
							? "This turn reached its request limit."
							: "This turn's access ended.",
				},
			},
			{
				status: authorization.status,
				// Claude Code must not retry a refusal that will not change.
				headers: { "x-should-retry": "false" },
			},
		);
	}
	const headers = new Headers();
	for (const [name, value] of request.headers)
		if (
			FORWARDED_REQUEST_HEADERS.has(name.toLowerCase()) ||
			name.toLowerCase().startsWith("x-stainless-")
		)
			headers.set(name, value);
	headers.set("authorization", `Bearer ${authorization.token}`);
	const target = `${CLAUDE_CODE_UPSTREAM}${url.pathname.slice(CLAUDE_CODE_PROXY_PREFIX.length)}${url.search}`;
	let response: Response;
	try {
		response = await (options.upstream ?? fetch)(target, {
			method: "POST",
			headers,
			body: request.body,
			redirect: "manual",
			signal: request.signal,
			duplex: "half",
		} as RequestInit);
	} catch {
		log("Claude Code proxy upstream failed.", { stage: "transport", route });
		return new Response(null, { status: 502 });
	}
	if (response.status >= 300 && response.status < 400) {
		await response.body?.cancel().catch(() => undefined);
		log("Claude Code proxy refused an upstream redirect.", { route });
		return new Response(null, { status: 502 });
	}
	if (response.status === 403)
		log("Claude Code upstream permission denied; saved login retained.", {
			status: response.status,
			route,
		});
	const outcome = claudeCodeUpstreamOutcome(response);
	if (outcome) {
		log("Claude Code upstream refused.", { status: response.status, route });
		// A model-specific token-counting probe cannot invalidate the login
		// used for inference. Only an actual message authentication failure can.
		if (outcome.kind !== "refused" || route === "messages")
			await options.onUpstream?.(grant, outcome).catch(() => undefined);
	}
	const usage = options.onUsage
		? claudePlanUsageFromHeaders(response.headers, Date.now())
		: null;
	if (usage)
		try {
			options.onUsage?.(grant, usage);
		} catch {
			log("Claude Code proxy could not record plan usage.", { route });
		}
	const forwarded = new Headers({ "cache-control": "no-store" });
	for (const [name, value] of response.headers) {
		const lower = name.toLowerCase();
		if (
			FORWARDED_RESPONSE_HEADERS.has(lower) ||
			lower.startsWith("anthropic-ratelimit-")
		)
			forwarded.set(name, value);
	}
	return new Response(response.body, {
		status: response.status,
		headers: forwarded,
	});
}
