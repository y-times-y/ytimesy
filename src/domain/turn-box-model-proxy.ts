import { MODEL_PROVIDERS, type ModelProvider } from "./model-connection";
import {
	presentedTurnBoxToken,
	type TurnBoxGrant,
	verifyTurnBoxGrant,
} from "./turn-box-grant";
import { TURN_BOX_PATHS } from "./turn-box-protocol";

/**
 * The edge's model proxy for turn runner boxes: API-KEY connections only.
 * The box sends the provider request (the SDK's own request, with a base URL
 * of `<edge>/box/v1/model` and the turn's grant as its API key); the edge
 * checks the grant's turn and lease, decrypts the turn's own connection,
 * and streams the request to the provider's OFFICIAL origin with the real
 * key. Codex and Claude subscriptions, xAI subscriptions and custom or
 * "compatible" endpoints are refused: only the origins below are reachable,
 * so a box (or a prompt-injected model) cannot aim the key at another host.
 * Bodies stream both ways; nothing here logs a key, a grant or a body.
 */
const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
const MAX_PATH_LENGTH = 200;

/** The only upstream origins: each provider's official API (not `compatible`). */
export const TURN_BOX_MODEL_ORIGINS: ReadonlySet<string> = new Set(
	Object.values(MODEL_PROVIDERS)
		.map((provider) => provider.baseUrl)
		.filter((url): url is string => Boolean(url))
		.map((url) => new URL(url).origin),
);

export type TurnBoxModelAuthorization =
	| {
			readonly kind: "ok";
			/** "key" is the only kind served; anything else is refused here too. */
			readonly connectionKind: string;
			readonly provider: ModelProvider;
			readonly baseUrl: string;
			readonly apiKey: string;
	  }
	/** The lease is gone, or the turn has no API-key connection. */
	| { readonly kind: "refused"; readonly status: 401 | 403 | 429 };

const FORWARDED_REQUEST_HEADERS = new Set([
	"accept",
	"anthropic-beta",
	"anthropic-version",
	"content-type",
	"openai-beta",
]);
const FORWARDED_RESPONSE_HEADERS = new Set([
	"content-type",
	"request-id",
	"x-request-id",
	"retry-after",
	"x-should-retry",
]);
/** Query parameters the providers' streaming endpoints use; no credentials. */
const ALLOWED_QUERY = new Set(["alt"]);

/** The provider path after the proxy prefix, or null when it is not a plain API path. */
export function turnBoxModelPath(url: URL): string | null {
	const prefix = `${TURN_BOX_PATHS.model}/`;
	if (!url.pathname.startsWith(prefix)) return null;
	const rest = url.pathname.slice(prefix.length);
	if (!rest || rest.length > MAX_PATH_LENGTH) return null;
	const segments = rest.split("/");
	if (
		segments.some(
			(segment) =>
				!/^[A-Za-z0-9._:-]+$/.test(segment) ||
				segment === "." ||
				segment === "..",
		)
	)
		return null;
	for (const name of url.searchParams.keys())
		if (!ALLOWED_QUERY.has(name)) return null;
	return `/${rest}${url.search}`;
}

function authHeaders(provider: ModelProvider, apiKey: string) {
	if (provider === "anthropic") return { "x-api-key": apiKey };
	if (provider === "google") return { "x-goog-api-key": apiKey };
	return { authorization: `Bearer ${apiKey}` };
}

/** The key in the `x-api-key`/`x-goog-api-key` or bearer slot an SDK puts its "API key" in. */
function presentedGrant(headers: Headers) {
	return (
		presentedTurnBoxToken(headers) ??
		headers.get("x-api-key") ??
		headers.get("x-goog-api-key")
	);
}

function refusal(status: number, message: string) {
	return Response.json(
		{ error: { type: "permission_error", message } },
		{ status, headers: { "x-should-retry": "false" } },
	);
}

export async function proxyTurnBoxModel(
	request: Request,
	options: {
		/** The edge's public key (a box cannot forge a grant without the private one). */
		readonly publicKey: string;
		/** Re-checks the lease and returns the turn's connection and its real key. */
		readonly authorize: (
			grant: TurnBoxGrant,
		) => Promise<TurnBoxModelAuthorization>;
		/**
		 * Reserves the request's tokens against the user's daily safety budget
		 * (api-usage-budget.ts) from its declared size, so a step needs no
		 * separate reserve request. When given, a body with no Content-Length
		 * is refused (411); false refuses with 429.
		 */
		readonly reserve?: (grant: TurnBoxGrant, bytes: number) => Promise<boolean>;
		readonly upstream?: typeof fetch;
		readonly now?: number;
		readonly log?: (message: string, detail: Record<string, unknown>) => void;
	},
): Promise<Response> {
	const log =
		options.log ?? ((message, detail) => console.warn(message, detail));
	const drop = () => request.body?.cancel().catch(() => undefined);
	const url = new URL(request.url);
	const path = turnBoxModelPath(url);
	if (request.method !== "POST" || !path) {
		await drop();
		return new Response(null, { status: 404 });
	}
	const grant = await verifyTurnBoxGrant(
		options.publicKey,
		presentedGrant(request.headers),
		options.now,
	);
	if (!grant) {
		await drop();
		return refusal(401, "This turn's access ended.");
	}
	const length = Number(request.headers.get("content-length") ?? "0");
	if (Number.isFinite(length) && length > MAX_REQUEST_BYTES) {
		await drop();
		return new Response(null, { status: 413 });
	}
	let authorization: TurnBoxModelAuthorization;
	try {
		authorization = await options.authorize(grant);
	} catch {
		log("Turn box model proxy authorization failed.", { stage: "authorize" });
		await drop();
		return new Response(null, { status: 503 });
	}
	if (authorization.kind !== "ok") {
		await drop();
		return refusal(authorization.status, "This turn's access ended.");
	}
	if (authorization.connectionKind !== "key") {
		await drop();
		return refusal(403, "Only API-key connections run on a turn box.");
	}
	let origin: string;
	try {
		const base = new URL(authorization.baseUrl);
		if (base.protocol !== "https:" || base.username || base.password)
			throw new Error("bad base URL");
		origin = base.origin;
	} catch {
		await drop();
		return refusal(403, "That model endpoint is not allowed.");
	}
	if (!TURN_BOX_MODEL_ORIGINS.has(origin)) {
		log("Turn box model proxy refused an origin.", {
			provider: authorization.provider,
		});
		await drop();
		return refusal(403, "That model endpoint is not allowed.");
	}
	if (options.reserve) {
		if (!request.headers.has("content-length") || !(length > 0)) {
			await drop();
			return new Response(null, { status: 411 });
		}
		let reserved = false;
		try {
			reserved = await options.reserve(grant, length);
		} catch {
			log("Turn box model proxy reservation failed.", { stage: "reserve" });
		}
		if (!reserved) {
			await drop();
			return refusal(429, "The daily API usage safety budget is reached.");
		}
	}
	const headers = new Headers();
	for (const [name, value] of request.headers)
		if (FORWARDED_REQUEST_HEADERS.has(name.toLowerCase()))
			headers.set(name, value);
	for (const [name, value] of Object.entries(
		authHeaders(authorization.provider, authorization.apiKey),
	))
		headers.set(name, value);
	const target = `${authorization.baseUrl.replace(/\/+$/, "")}${path}`;
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
		log("Turn box model proxy upstream failed.", { stage: "transport" });
		return new Response(null, { status: 502 });
	}
	if (response.status >= 300 && response.status < 400) {
		await response.body?.cancel().catch(() => undefined);
		log("Turn box model proxy refused an upstream redirect.", {});
		return new Response(null, { status: 502 });
	}
	const forwarded = new Headers({ "cache-control": "no-store" });
	for (const [name, value] of response.headers) {
		const lower = name.toLowerCase();
		if (
			FORWARDED_RESPONSE_HEADERS.has(lower) ||
			lower.startsWith("anthropic-ratelimit-") ||
			lower.startsWith("x-ratelimit-")
		)
			forwarded.set(name, value);
	}
	return new Response(response.body, {
		status: response.status,
		headers: forwarded,
	});
}
