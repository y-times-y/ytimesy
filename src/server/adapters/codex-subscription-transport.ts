import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import { readBoundedRequestBody } from "#/domain/bounded-request-body";
import {
	signDeliveryRequest,
	verifyDeliveryRequest,
} from "#/domain/delivery-auth";
import { PINNED_CODEX_CLI_VERSION } from "#/domain/guest-cli-pin";
import { codexExternalTokens } from "../auth/codex-managed-auth";

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
export function codexRelayConfigured() {
	return (
		!subscriptionEgress.getStore() && !!process.env.YTIMESY_CODEX_RELAY_URL
	);
}

async function relayRequest(
	userId: string,
	request: Operation,
	accountId?: string,
	signal?: AbortSignal | null,
) {
	const url = new URL(process.env.YTIMESY_CODEX_RELAY_URL ?? "");
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		url.pathname !== "/api/internal/codex-transport"
	)
		throw new Error("Invalid subscription relay URL.");
	const body = JSON.stringify({ userId, accountId, operation: request });
	if (new TextEncoder().encode(body).byteLength > maximumBytes)
		throw new Error("Subscription relay payload exceeds the limit.");
	const response = await fetch(url, {
		method: "POST",
		body,
		signal: signal ?? AbortSignal.timeout(30_000),
		redirect: "manual",
		headers: {
			"Content-Type": "application/json",
			...(await signDeliveryRequest(relaySecret(), "POST", url.href, body)),
		},
	});
	if (response.status >= 300 && response.status < 400) {
		await response.body?.cancel();
		throw new Error("Subscription relay redirects are not allowed.");
	}
	return response;
}

/** The backend alone refreshes OAuth tokens when relay mode is explicitly selected. */
export async function subscriptionConnection(userId: string) {
	if (!codexRelayConfigured()) return codexExternalTokens(userId);
	const response = await relayRequest(userId, { kind: "identity" });
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

export async function subscriptionFetch(
	userId: string,
	path: string,
	init?: RequestInit,
	accountId?: string,
) {
	const headers = new Headers(init?.headers);
	if (codexRelayConfigured()) {
		const request: Operation =
			init?.method === "POST"
				? operation.parse({
						kind: "inference",
						path,
						body: init.body,
						sessionId: headers.get("session-id") ?? undefined,
					})
				: operation.parse({ kind: "metadata", path });
		return relayRequest(userId, request, accountId, init?.signal);
	}
	const tokens = await codexExternalTokens(userId);
	if (accountId && accountId !== tokens.chatgptAccountId)
		throw new Error("Subscription account changed; restart this turn.");
	headers.set("Authorization", `Bearer ${tokens.accessToken}`);
	headers.set("ChatGPT-Account-ID", tokens.chatgptAccountId);
	headers.set("User-Agent", "ytimesy/1.0");
	const request = subscriptionEgress.getStore() ?? fetch;
	return request(`${backend}/${path}`, {
		...init,
		headers,
		redirect: "manual",
	});
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
		const tokens = await codexExternalTokens(input.userId);
		if (input.accountId && input.accountId !== tokens.chatgptAccountId)
			return new Response(null, { status: 409 });
		if (input.operation.kind === "identity")
			return Response.json(
				{ accountId: tokens.chatgptAccountId },
				{ headers: { "Cache-Control": "no-store" } },
			);
		const metadata = input.operation.kind === "metadata";
		const headers = new Headers({
			Authorization: `Bearer ${tokens.accessToken}`,
			"ChatGPT-Account-ID": tokens.chatgptAccountId,
			"User-Agent": "ytimesy/1.0",
			Accept: metadata ? "application/json" : "text/event-stream",
			"Content-Type": "application/json",
		});
		if (input.operation.kind === "inference" && input.operation.sessionId)
			headers.set("session-id", input.operation.sessionId);
		const signal = metadata
			? AbortSignal.any([request.signal, AbortSignal.timeout(7_000)])
			: request.signal;
		const response = await fetch(`${backend}/${input.operation.path}`, {
			method: metadata ? "GET" : "POST",
			headers,
			signal,
			redirect: "manual",
			...(input.operation.kind === "inference"
				? { body: input.operation.body }
				: {}),
		});
		if (!response.ok) {
			await response.body?.cancel();
			return Response.json(
				{
					error: {
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
