import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
	CodexEgressUnavailable,
	usageLimitReset,
} from "#/domain/api-turn-failure";
import { readBoundedRequestBody } from "#/domain/bounded-request-body";
import {
	type CodexEgressBlock,
	CodexEgressHealth,
	MAX_CODEX_RELAYS,
	relayEgressBlock,
	upstreamEgressBlock,
} from "#/domain/codex-egress";
import {
	signDeliveryRequest,
	verifyDeliveryRequest,
} from "#/domain/delivery-auth";
import { PINNED_CODEX_CLI_VERSION } from "#/domain/guest-cli-pin";
import {
	codexEgressBlockedAlert,
	codexEgressExhaustedAlert,
} from "#/domain/owner-alerts";
import { codexExternalTokens } from "../auth/codex-managed-auth";
import { recordStepTiming, timed } from "../services/step-timing";
import { markTurnPhase } from "../services/turn-timing";
import { captureServerAnalytics } from "./analytics";
import { trackInvocationTask } from "./invocation-tasks";
import { alertOwner } from "./owner-alerts";

const backend = "https://chatgpt.com/backend-api";
const maximumBytes = 8 * 1024 * 1024;
const catalogPath = `codex/models?client_version=${PINNED_CODEX_CLI_VERSION}`;
const subscriptionEgress = new AsyncLocalStorage<typeof fetch>();

/** Invocation-local VPC egress; never changes another chat's transport. */
export function withCodexSubscriptionEgress<T>(
	request: typeof fetch,
	run: () => Promise<T>,
) {
	return subscriptionEgress.run(request, run);
}
const operation = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("identity") }).strict(),
	z
		.object({
			kind: z.literal("metadata"),
			path: z.enum([catalogPath, "wham/usage"]),
		})
		.strict(),
	z
		.object({
			kind: z.literal("inference"),
			path: z.enum(["codex/responses", "codex/responses/compact"]),
			body: z.string().max(maximumBytes),
			sessionId: z
				.string()
				.regex(/^[a-f0-9]{64}$/)
				.optional(),
		})
		.strict(),
]);
const envelope = z
	.object({
		userId: z.string().min(1).max(256),
		accountId: z.string().min(1).max(256).optional(),
		operation,
	})
	.strict();
type Operation = z.infer<typeof operation>;

function relaySecret() {
	const key = process.env.YTIMESY_CODEX_RELAY_SECRET;
	if (!key || key.length < 32)
		throw new Error("Subscription relay signing key is missing.");
	return key;
}

type EgressPath =
	| { id: "vpc" | "direct"; kind: "upstream"; request: typeof fetch }
	| { id: string; kind: "relay"; url: URL; secret: string };
type RelayPath = Extract<EgressPath, { kind: "relay" }>;

/**
 * Relays in failover order: YTIMESY_CODEX_RELAY_URL/_SECRET, then the same
 * names suffixed _2.._8. Each relay host verifies with its own signing key.
 * A malformed entry is a configuration error, never silently skipped.
 */
function configuredRelays(
	env: Readonly<Record<string, string | undefined>> = process.env,
): RelayPath[] {
	const relays: RelayPath[] = [];
	for (let index = 1; index <= MAX_CODEX_RELAYS; index++) {
		const suffix = index === 1 ? "" : `_${index}`;
		const href = env[`YTIMESY_CODEX_RELAY_URL${suffix}`];
		if (!href) continue;
		const url = new URL(href);
		if (
			url.protocol !== "https:" ||
			url.username ||
			url.password ||
			url.search ||
			url.hash ||
			url.pathname !== "/api/internal/codex-transport"
		)
			throw new Error("Invalid subscription relay URL.");
		const secret = env[`YTIMESY_CODEX_RELAY_SECRET${suffix}`];
		if (!secret || secret.length < 32)
			throw new Error("Subscription relay signing key is missing.");
		relays.push({ id: `relay-${index}`, kind: "relay", url, secret });
	}
	return relays;
}

/**
 * This invocation's paths: the VPC binding first when the edge installed one,
 * then every relay. Without a binding, configured relays alone (the backend
 * keeps OAuth tokens); with neither, ordinary fetch (Node and tests).
 */
function egressPaths(): EgressPath[] {
	const vpc = subscriptionEgress.getStore();
	const relays = configuredRelays();
	if (vpc) return [{ id: "vpc", kind: "upstream", request: vpc }, ...relays];
	if (relays.length) return relays;
	return [
		{
			id: "direct",
			kind: "upstream",
			request: (input, init) => fetch(input, init),
		},
	];
}
function relayOnly(paths: readonly EgressPath[]) {
	return paths.every((path) => path.kind === "relay");
}

async function relayRequest(
	relay: RelayPath,
	userId: string,
	request: Operation,
	accountId: string | undefined,
	signal: AbortSignal | undefined,
) {
	const body = JSON.stringify({ userId, accountId, operation: request });
	if (new TextEncoder().encode(body).byteLength > maximumBytes)
		throw new Error("Subscription relay payload exceeds the limit.");
	const headers = {
		"Content-Type": "application/json",
		...(await signDeliveryRequest(relay.secret, "POST", relay.url.href, body)),
	};
	const response = await network(() =>
		fetch(relay.url, {
			method: "POST",
			body,
			signal,
			redirect: "manual",
			headers,
		}),
	);
	if (response.status >= 300 && response.status < 400) {
		await response.body?.cancel();
		throw new EgressNetworkFailure(
			new Error("Subscription relay redirects are not allowed."),
			"redirect",
		);
	}
	return response;
}

/** Marks a failure of the network call itself, as opposed to token or account errors. */
class EgressNetworkFailure extends Error {
	constructor(
		cause: unknown,
		readonly block: CodexEgressBlock = "transport",
	) {
		super("Codex egress request failed.", { cause });
		this.name = "EgressNetworkFailure";
	}
}
async function network(send: () => Promise<Response>) {
	try {
		return await send();
	} catch (error) {
		throw new EgressNetworkFailure(error);
	}
}

/** Time to response headers per path before trying the next one. */
const firstByteDeadline = {
	identity: 10_000,
	metadata: 6_000,
	inference: 45_000,
} as const;
const health = new CodexEgressHealth();

type Attempt =
	| { response: Response }
	| {
			block: CodexEgressBlock;
			status?: number;
			/** What the caller saw before failover existed, when no path is left. */
			outcome: () => Response;
	  };

/**
 * One path, up to response headers. Network failures, the per-path deadline
 * and blocked answers become a block; caller cancellation, token and account
 * errors propagate unchanged. An error response is rebuilt from its
 * already-read body so the caller sees it as before. The last candidate gets
 * no deadline of its own: there is nowhere left to go.
 */
async function attemptPath(
	path: EgressPath,
	deadlineMs: number | null,
	callerSignal: AbortSignal | null | undefined,
	send: (
		path: EgressPath,
		signal: AbortSignal | undefined,
	) => Promise<Response>,
): Promise<Attempt> {
	const deadline = new AbortController();
	const timer =
		deadlineMs === null
			? undefined
			: setTimeout(
					() =>
						deadline.abort(
							new DOMException(
								"No Codex response headers in time.",
								"TimeoutError",
							),
						),
					deadlineMs,
				);
	const signal =
		deadlineMs === null
			? (callerSignal ?? undefined)
			: callerSignal
				? AbortSignal.any([callerSignal, deadline.signal])
				: deadline.signal;
	let response: Response;
	try {
		response = await send(path, signal);
	} catch (error) {
		const original =
			error instanceof EgressNetworkFailure ? error.cause : error;
		if (callerSignal?.aborted) throw original;
		const block = deadline.signal.aborted
			? "timeout"
			: error instanceof EgressNetworkFailure
				? error.block
				: undefined;
		if (!block) throw error;
		return {
			block,
			outcome: () => {
				throw original;
			},
		};
	} finally {
		clearTimeout(timer);
	}
	if (response.ok) return { response };
	const text = await readBoundedRequestBody(response, 64 * 1024).catch(
		() => "",
	);
	const rebuilt = () =>
		new Response(text || null, {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});
	const block =
		path.kind === "relay"
			? relayEgressBlock({ status: response.status, text })
			: upstreamEgressBlock({
					status: response.status,
					headers: response.headers,
					text,
				});
	if (block) return { block, status: response.status, outcome: rebuilt };
	return { response: rebuilt() };
}

function reportBlocked(
	userId: string,
	path: string,
	block: CodexEgressBlock,
	outcome: "switched" | "exhausted",
) {
	if (!health.markBlocked(path, block)) return;
	console.warn("Codex egress path blocked.", { path, reason: block });
	trackInvocationTask(alertOwner(codexEgressBlockedAlert(path, block)));
	void captureServerAnalytics(
		userId,
		"codex_egress_failover",
		{ path, reason: block, outcome },
		{ key: randomUUID(), timestamp: new Date() },
	);
}

/**
 * Sends one request over the first path that is not blocked, before any
 * response byte reaches the caller. A body that cannot be resent (not a
 * string) uses only the first path. A response that started streaming is
 * never retried: failover ends when headers arrive.
 */
async function throughEgress(
	userId: string,
	options: {
		paths: readonly EgressPath[];
		deadlineMs: number;
		signal?: AbortSignal | null;
		replayable: boolean;
		/** A model request: the step's timing line names the path that served it. */
		inference?: boolean;
	},
	send: (
		path: EgressPath,
		signal: AbortSignal | undefined,
	) => Promise<Response>,
): Promise<Response> {
	const ordered = health.order(options.paths);
	const candidates = options.replayable ? ordered : ordered.slice(0, 1);
	const blocked: { path: string; reason: CodexEgressBlock }[] = [];
	let last: Extract<Attempt, { block: CodexEgressBlock }> | undefined;
	for (const [index, path] of candidates.entries()) {
		const final = index === candidates.length - 1;
		const startedAt = Date.now();
		const attempt = await attemptPath(
			path,
			final ? null : options.deadlineMs,
			options.signal,
			send,
		);
		if ("response" in attempt) {
			if (health.markHealthy(path.id))
				console.info("Codex egress path recovered.", { path: path.id });
			if (blocked.length)
				console.warn("Codex egress failed over.", {
					served: path.id,
					blocked,
				});
			recordStepTiming(`egress:${path.id}`, Date.now() - startedAt, startedAt);
			if (options.inference) markTurnPhase(`egress:${path.id}`);
			return attempt.response;
		}
		last = attempt;
		blocked.push({ path: path.id, reason: attempt.block });
		reportBlocked(
			userId,
			path.id,
			attempt.block,
			final ? "exhausted" : "switched",
		);
	}
	console.warn("Every Codex egress path is blocked.", { blocked });
	trackInvocationTask(alertOwner(codexEgressExhaustedAlert(blocked)));
	// With a single candidate there was nothing to fail over to; keep its own outcome.
	if (candidates.length === 1 && last) return last.outcome();
	throw new CodexEgressUnavailable(blocked);
}

/** The backend alone refreshes OAuth tokens when relays are the only egress. */
export async function subscriptionConnection(userId: string) {
	const paths = egressPaths();
	if (!relayOnly(paths))
		return timed("auth:tokens", () => codexExternalTokens(userId));
	const response = await throughEgress(
		userId,
		{ paths, deadlineMs: firstByteDeadline.identity, replayable: true },
		(path, signal) =>
			relayRequest(
				path as RelayPath,
				userId,
				{ kind: "identity" },
				undefined,
				signal,
			),
	);
	if (!response.ok) {
		await response.body?.cancel();
		throw new Error("Subscription relay identity is unavailable.");
	}
	const identity = z
		.object({ accountId: z.string().min(1) })
		.strict()
		.parse(JSON.parse(await readBoundedRequestBody(response, 1024)));
	return {
		chatgptAccountId: identity.accountId,
		accessToken: "subscription-relay",
	};
}

/** One request to chatgpt.com through one path, with that path's credentials. */
function sendOverPath(
	userId: string,
	path: EgressPath,
	backendPath: string,
	init: RequestInit | undefined,
	signal: AbortSignal | undefined,
	accountId?: string,
	loaded?: { accessToken: string; chatgptAccountId: string },
) {
	if (path.kind === "relay") {
		const headers = new Headers(init?.headers);
		const request: Operation =
			init?.method === "POST"
				? operation.parse({
						kind: "inference",
						path: backendPath,
						body: init.body,
						sessionId: headers.get("session-id") ?? undefined,
					})
				: operation.parse({ kind: "metadata", path: backendPath });
		return relayRequest(path, userId, request, accountId, signal);
	}
	return withRevokedTokenRetry(init?.body, async (forceRefresh) => {
		const tokens =
			!forceRefresh && loaded
				? loaded
				: await timed("auth:tokens", () =>
						forceRefresh
							? codexExternalTokens(userId, true)
							: codexExternalTokens(userId),
					);
		if (accountId && accountId !== tokens.chatgptAccountId)
			throw new Error("Subscription account changed; restart this turn.");
		const headers = new Headers(init?.headers);
		headers.set("Authorization", `Bearer ${tokens.accessToken}`);
		headers.set("ChatGPT-Account-ID", tokens.chatgptAccountId);
		headers.set("User-Agent", "ytimesy/1.0");
		return network(() =>
			path.request(`${backend}/${backendPath}`, {
				...init,
				headers,
				signal,
				redirect: "manual",
			}),
		);
	});
}

export async function subscriptionFetch(
	userId: string,
	path: string,
	init?: RequestInit,
	accountId?: string,
	/** A token this caller read moments ago; used for the first attempt only. */
	loaded?: { accessToken: string; chatgptAccountId: string },
) {
	const paths = egressPaths();
	// Relay mode keeps tokens on the backend; the DO never holds them.
	const reuse = relayOnly(paths) ? undefined : loaded;
	let first = true;
	return throughEgress(
		userId,
		{
			paths,
			deadlineMs:
				init?.method === "POST"
					? firstByteDeadline.inference
					: firstByteDeadline.metadata,
			signal: init?.signal,
			replayable: init?.body == null || typeof init.body === "string",
			inference: init?.method === "POST",
		},
		(egress, signal) => {
			const token = first ? reuse : undefined;
			first = false;
			return sendOverPath(userId, egress, path, init, signal, accountId, token);
		},
	);
}

/**
 * Probes codex/models on every configured path in order with this user's
 * subscription (the owner's, from a scheduled job) and updates path health,
 * so a recovered path is used again and a newly blocked one is alerted on.
 * Health lives in this isolate; other isolates learn from their own requests.
 */
export async function probeCodexEgress(userId: string) {
	const paths = egressPaths();
	const results: {
		path: string;
		outcome: "ok" | "rejected" | CodexEgressBlock;
		status?: number;
		ms: number;
	}[] = [];
	for (const path of paths) {
		const startedAt = Date.now();
		const attempt = await attemptPath(
			path,
			firstByteDeadline.metadata,
			null,
			(egress, signal) =>
				sendOverPath(
					userId,
					egress,
					catalogPath,
					{ headers: { Accept: "application/json" } },
					signal,
				),
		);
		const ms = Date.now() - startedAt;
		if ("block" in attempt) {
			reportBlocked(userId, path.id, attempt.block, "switched");
			results.push({
				path: path.id,
				outcome: attempt.block,
				status: attempt.status,
				ms,
			});
			continue;
		}
		await attempt.response.body?.cancel().catch(() => {});
		// Reachable: an account error (expired login, limits) is not the path's fault.
		health.markHealthy(path.id);
		results.push({
			path: path.id,
			outcome: attempt.response.ok ? "ok" : "rejected",
			status: attempt.response.status,
			ms,
		});
	}
	const blocked = results.flatMap((row) =>
		row.outcome === "ok" || row.outcome === "rejected"
			? []
			: [{ path: row.path, reason: row.outcome }],
	);
	if (blocked.length === results.length)
		await alertOwner(codexEgressExhaustedAlert(blocked));
	return results;
}

/** Test hook: forget path health between cases. */
export function resetCodexEgressHealthForTests() {
	health.reset();
}

/**
 * A plan change can revoke an access token before its embedded expiry. HTTP 401 means
 * the request was rejected unprocessed, so one forced refresh and resend cannot duplicate work.
 */
async function withRevokedTokenRetry(
	body: RequestInit["body"],
	send: (forceRefresh: boolean) => Promise<Response>,
) {
	const response = await send(false);
	if (response.status !== 401 || !(body == null || typeof body === "string"))
		return response;
	await response.body?.cancel();
	return send(true);
}

/** Server-to-server only; fixed destinations, fresh owner credentials, no retries or logs. */
export async function handleCodexSubscriptionRelay(
	request: Request,
): Promise<Response> {
	if (request.method !== "POST") return new Response(null, { status: 405 });
	let secret: string;
	try {
		secret = relaySecret();
	} catch {
		return new Response(null, { status: 503 });
	}
	if (
		!request.headers.has("x-ytimesy-delivery-signature") ||
		!request.headers.has("x-ytimesy-delivery-expires")
	)
		return new Response(null, { status: 401 });
	let body: string;
	try {
		body = await readBoundedRequestBody(request, maximumBytes);
	} catch {
		return new Response(null, { status: 413 });
	}
	if (!(await verifyDeliveryRequest(secret, request, body)))
		return new Response(null, { status: 401 });
	let input: z.infer<typeof envelope>;
	try {
		input = envelope.parse(JSON.parse(body));
	} catch {
		return new Response(null, { status: 400 });
	}
	try {
		let tokens = await codexExternalTokens(input.userId);
		if (input.accountId && input.accountId !== tokens.chatgptAccountId)
			return new Response(null, { status: 409 });
		const operation = input.operation;
		if (operation.kind === "identity")
			return Response.json(
				{ accountId: tokens.chatgptAccountId },
				{ headers: { "Cache-Control": "no-store" } },
			);
		const metadata = operation.kind === "metadata";
		const body = operation.kind === "inference" ? operation.body : undefined;
		const signal = metadata
			? AbortSignal.any([request.signal, AbortSignal.timeout(7_000)])
			: request.signal;
		const response = await withRevokedTokenRetry(body, async (forceRefresh) => {
			if (forceRefresh) {
				tokens = await codexExternalTokens(input.userId, true);
				if (input.accountId && input.accountId !== tokens.chatgptAccountId)
					return new Response(null, { status: 409 });
			}
			const headers = new Headers({
				Authorization: `Bearer ${tokens.accessToken}`,
				"ChatGPT-Account-ID": tokens.chatgptAccountId,
				"User-Agent": "ytimesy/1.0",
				Accept: metadata ? "application/json" : "text/event-stream",
				"Content-Type": "application/json",
			});
			if (operation.kind === "inference" && operation.sessionId)
				headers.set("session-id", operation.sessionId);
			return fetch(`${backend}/${operation.path}`, {
				method: metadata ? "GET" : "POST",
				headers,
				signal,
				redirect: "manual",
				...(body === undefined ? {} : { body }),
			});
		});
		if (!response.ok) {
			// Only a spent allowance's reset time and whether this host's egress
			// was blocked cross the relay; never the upstream body.
			const text = await readBoundedRequestBody(response, 64 * 1024).catch(
				() => "",
			);
			const resetsAt =
				response.status === 429 ? usageLimitReset(text) : undefined;
			if (resetsAt !== undefined)
				return Response.json(
					{
						error: {
							type: "usage_limit_reached",
							...(resetsAt
								? { resets_at: Math.floor(resetsAt.getTime() / 1000) }
								: {}),
						},
					},
					{ status: 429, headers: { "Cache-Control": "no-store" } },
				);
			return Response.json(
				{
					error: upstreamEgressBlock({
						status: response.status,
						headers: response.headers,
						text,
					})
						? {
								type: "subscription_egress_blocked",
								message: "Subscription egress blocked at this relay.",
							}
						: {
								type: "subscription_upstream_error",
								message: "Subscription request rejected.",
							},
				},
				{
					status: response.status >= 400 ? response.status : 502,
					headers: { "Cache-Control": "no-store" },
				},
			);
		}
		return new Response(response.body, {
			status: response.status,
			headers: {
				"Content-Type":
					response.headers.get("content-type") ?? "application/octet-stream",
				"Cache-Control": "no-store",
				"X-Accel-Buffering": "no",
			},
		});
	} catch {
		return Response.json(
			{
				error: {
					type: "subscription_transport_error",
					message: "Subscription transport unavailable.",
				},
			},
			{ status: 502, headers: { "Cache-Control": "no-store" } },
		);
	}
}
