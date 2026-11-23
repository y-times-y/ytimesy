import { z } from "zod";
import {
	type ClaudeCodeGrant,
	presentedClaudeCodeGrant,
	verifyClaudeCodeGrant,
} from "../../domain/claude-code-grant";
import {
	handleMcpMessage,
	type McpToolDefinition,
} from "../../domain/claude-code-mcp";
import {
	type McpMessageRetry,
	mcpMessageRetry,
} from "../../domain/claude-code-mcp-retry";
import {
	CLAUDE_CODE_PROXY_PREFIX,
	proxyClaudeCode,
} from "../../domain/claude-code-proxy";
import { claudeSubscriptionEnabled } from "../../domain/claude-code-route";
import {
	CLAUDE_CODE_FEED_PATH,
	claudeFeedEnabled,
	presentedFeedGrant,
} from "../../domain/claude-feed";
import { modelConversationName } from "../../domain/model-conversation-routing";
import {
	authorizeClaudeCodeProxy,
	recordClaudeCodeUpstream,
	recordClaudePlanUsage,
} from "../adapters/claude-subscription";
import { withDatabaseScope } from "../adapters/database-scope";
import { queuedMessageMaybeSent } from "../adapters/peer-inbox-observation";
import {
	CLAUDE_CODE_CALL_TIMEOUT_MS,
	CLAUDE_CODE_INBOX_CALL,
	claudeCodeBridgeTools,
	requestClaudeCodeCall,
} from "../services/claude-code-bridge";
import {
	relayClaudeCall,
	relayedClaudeTools,
	relaysToBox,
} from "./claude-relay";
import { durableObjectLocation } from "./durable-object-location";
import type { EdgeExecutorEnvironment } from "./environment";

export const CLAUDE_CODE_MCP_PATH = `${CLAUDE_CODE_PROXY_PREFIX}/mcp`;
const MAX_MCP_BODY = 1024 * 1024;

/**
 * The last plan usage write per user in this isolate, so most of a turn's
 * requests open no database connection (the database throttles too).
 */
const planUsageWrites = new Map<
	string,
	{ at: number; status: string | null }
>();
const PLAN_USAGE_WRITE_EVERY_MS = 15_000;

export function shouldWritePlanUsage(
	userId: string,
	status: string | null,
	now: number,
) {
	const last = planUsageWrites.get(userId);
	if (
		last &&
		last.status === status &&
		now - last.at < PLAN_USAGE_WRITE_EVERY_MS
	)
		return false;
	if (planUsageWrites.size > 1000) planUsageWrites.clear();
	planUsageWrites.set(userId, { at: now, status });
	return true;
}

const claudeCodeSecrets = z.object({ GIT_PROXY_SECRET: z.string().min(32) });

export function isClaudeCodeEdgePath(path: string) {
	return (
		path === CLAUDE_CODE_PROXY_PREFIX ||
		path.startsWith(`${CLAUDE_CODE_PROXY_PREFIX}/`)
	);
}

/**
 * The VM's Claude Code traffic: model requests through the proxy, and
 * ytimesy's MCP tools, which the chat's Durable Object (the one running the
 * turn) answers. Off unless YTIMESY_CLAUDE_SUBSCRIPTION_ENABLED=1.
 */
export async function routeClaudeCodeEdge(
	request: Request,
	env: EdgeExecutorEnvironment,
	/** Keeps the plan usage write alive after the response is returned. */
	waitUntil?: (promise: Promise<unknown>) => void,
): Promise<Response> {
	if (!claudeSubscriptionEnabled()) return new Response(null, { status: 404 });
	const secrets = claudeCodeSecrets.safeParse(env);
	if (!secrets.success) return new Response(null, { status: 503 });
	const secret = secrets.data.GIT_PROXY_SECRET;
	const path = new URL(request.url).pathname;
	// The run's output feed: a WebSocket to the same chat object, with the
	// same grant as its MCP requests (claude-feed.ts).
	if (path === CLAUDE_CODE_FEED_PATH) {
		if (!claudeFeedEnabled()) return new Response(null, { status: 404 });
		if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
			return new Response(null, { status: 426 });
		const grant = await verifyClaudeCodeGrant(
			secret,
			presentedFeedGrant(request.headers),
		);
		if (!grant) return new Response(null, { status: 401 });
		return env.MODEL_CONVERSATIONS.getByName(
			modelConversationName(grant),
			durableObjectLocation(),
		).fetch(
			new Request(`https://chat.internal${CLAUDE_CODE_FEED_PATH}`, {
				headers: request.headers,
			}),
		);
	}
	if (path === CLAUDE_CODE_MCP_PATH) {
		const grant = await verifyClaudeCodeGrant(
			secret,
			presentedClaudeCodeGrant(request.headers),
		);
		if (!grant) return new Response(null, { status: 401 });
		const chat = env.MODEL_CONVERSATIONS.getByName(
			modelConversationName(grant),
			durableObjectLocation(),
		);
		// A turn on a box: this request holds the call, the box runs it.
		if (relaysToBox(grant))
			return answerRelayedClaudeCodeMcp(
				request,
				chat,
				() => chat.claudeRelayTools(grant.turnId),
				request.headers.get("authorization") ??
					`Bearer ${presentedClaudeCodeGrant(request.headers) ?? ""}`,
			);
		return forwardClaudeCodeMcp(request, chat);
	}
	const connection = env.HYPERDRIVE.connectionString;
	return proxyClaudeCode(request, {
		secret,
		authorize: (grant) =>
			withDatabaseScope(
				connection,
				() => authorizeClaudeCodeProxy(grant),
				null,
			),
		onUpstream: (grant, outcome) =>
			withDatabaseScope(
				connection,
				() => recordClaudeCodeUpstream(grant.userId, outcome),
				null,
			),
		onUsage: waitUntil
			? (grant, usage) => {
					if (!shouldWritePlanUsage(grant.userId, usage.status, usage.readAt))
						return;
					waitUntil(
						withDatabaseScope(
							connection,
							() => recordClaudePlanUsage(grant.userId, usage),
							null,
						).catch(() => {
							console.warn("Claude plan usage was not recorded.");
						}),
					);
				}
			: undefined,
	});
}

/** Waits before each repeat of a message the chat's object did not answer. */
const MCP_FORWARD_RETRY_PAUSES_MS = [250, 1_000, 2_500];

/**
 * In the edge Worker: one MCP message for a turn whose step runs in the
 * chat's Durable Object, passed to that object. The object resets on a
 * deploy and when its isolate runs out of memory, failing every request it
 * holds; the Worker used to answer those with an empty 503, which the run
 * showed as "Error POSTing to endpoint:" (2026-11-21, 2026-11-23). A
 * message that is safe to send again (claude-code-mcp-retry.ts) is sent
 * again a few times; any other failure is answered with what failed.
 */
export async function forwardClaudeCodeMcp(
	request: Request,
	chat: { fetch(request: Request): Promise<Response> },
	pause: (ms: number) => Promise<void> = (ms) =>
		new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<Response> {
	const authorization = request.headers.get("authorization") ?? "";
	const body = request.method === "POST" ? await request.text() : null;
	if (body !== null && body.length > MAX_MCP_BODY)
		return new Response(null, { status: 413 });
	let parsed: unknown = null;
	try {
		parsed = body === null ? null : JSON.parse(body);
	} catch {}
	const retry = mcpMessageRetry(parsed);
	const send = () =>
		chat.fetch(
			new Request(`https://chat.internal${CLAUDE_CODE_MCP_PATH}`, {
				method: request.method,
				headers: {
					authorization,
					"content-type": "application/json",
				},
				body,
			}),
		);
	for (let attempts = 1; ; attempts++) {
		let failure: string;
		let errorName: string | undefined;
		try {
			const response = await send();
			if (response.status < 500) return response;
			failure = `it answered HTTP ${response.status}`;
			await response.body?.cancel().catch(() => undefined);
		} catch (error) {
			failure = chatObjectFailure(error);
			errorName = error instanceof Error ? error.name : typeof error;
		}
		console.warn("Claude Code MCP message to the chat object failed.", {
			message: retry.label,
			attempt: attempts,
			repeatable: retry.repeatable,
			failure,
			...(errorName ? { errorName } : {}),
		});
		const wait = MCP_FORWARD_RETRY_PAUSES_MS[attempts - 1];
		if (!retry.repeatable || wait === undefined)
			return mcpForwardFailure(retry, failure, attempts);
		await pause(wait);
	}
}

/**
 * Why the chat's object failed a request, in words the run can show. Only
 * the runtime's own reset and network messages are named: an error the
 * object threw may carry database or provider details.
 */
function chatObjectFailure(error: unknown): string {
	const text = error instanceof Error ? error.message : String(error);
	if (/code was updated/i.test(text)) return "it restarted for a deploy";
	if (/memory limit/i.test(text)) return "it ran out of memory and restarted";
	if (/overloaded/i.test(text)) return "it was overloaded";
	if (/network connection lost|disconnected|connection reset/i.test(text))
		return "the connection to it was lost";
	return "it failed with an internal error";
}

/** The answer to a message the chat's object did not answer: never an empty error. */
function mcpForwardFailure(
	retry: McpMessageRetry,
	failure: string,
	attempts: number,
): Response {
	const text = [
		`ytimesy's edge could not get an answer from this chat's server (its Durable Object) for ${retry.label}: ${failure}${
			attempts > 1 ? ` (tried ${attempts} times)` : ""
		}.`,
		retry.repeatable
			? "This call is safe to repeat; try it again."
			: "The call may have run before that; its outcome is unknown. Check its effect before repeating it.",
	].join(" ");
	// A notification has no id to answer; its text still reaches the run.
	if (retry.id === undefined)
		return new Response(text, {
			status: 503,
			headers: { "content-type": "text/plain; charset=utf-8" },
		});
	return Response.json(
		retry.toolCall
			? {
					jsonrpc: "2.0",
					id: retry.id,
					result: { content: [{ type: "text", text }], isError: true },
				}
			: {
					jsonrpc: "2.0",
					id: retry.id,
					error: { code: -32603, message: text },
				},
	);
}

/**
 * Inside the chat's Durable Object: the grant of a relayed call's socket
 * (claude-relay.ts), checked against this chat and marked for a box.
 */
export async function verifiedClaudeRelayGrant(
	request: Request,
	env: EdgeExecutorEnvironment,
	expectedName: (name: string) => boolean,
): Promise<ClaudeCodeGrant | Response> {
	if (!claudeSubscriptionEnabled()) return new Response(null, { status: 404 });
	const secrets = claudeCodeSecrets.safeParse(env);
	if (!secrets.success) return new Response(null, { status: 503 });
	if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
		return new Response(null, { status: 426 });
	const grant = await verifyClaudeCodeGrant(
		secrets.data.GIT_PROXY_SECRET,
		presentedClaudeCodeGrant(request.headers),
	);
	if (
		!grant ||
		!relaysToBox(grant) ||
		!expectedName(modelConversationName(grant))
	)
		return new Response(null, { status: 401 });
	return grant;
}

/**
 * Inside the chat's Durable Object: the grant of a feed upgrade, checked
 * again against this chat, or the response refusing it.
 */
export async function verifiedClaudeFeedGrant(
	request: Request,
	env: EdgeExecutorEnvironment,
	expectedName: (name: string) => boolean,
): Promise<ClaudeCodeGrant | Response> {
	if (!claudeSubscriptionEnabled() || !claudeFeedEnabled())
		return new Response(null, { status: 404 });
	const secrets = claudeCodeSecrets.safeParse(env);
	if (!secrets.success) return new Response(null, { status: 503 });
	if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
		return new Response(null, { status: 426 });
	const grant = await verifyClaudeCodeGrant(
		secrets.data.GIT_PROXY_SECRET,
		presentedFeedGrant(request.headers),
	);
	if (!grant || !expectedName(modelConversationName(grant)))
		return new Response(null, { status: 401 });
	return grant;
}

/** The JSON-RPC message of an MCP POST, or the response refusing it. */
async function mcpRequestMessage(
	request: Request,
): Promise<{ message: unknown } | Response> {
	// No server-sent stream and no session to end: plain JSON per POST.
	if (request.method !== "POST")
		return new Response(null, { status: 405, headers: { allow: "POST" } });
	const text = await request.text();
	if (text.length > MAX_MCP_BODY) return new Response(null, { status: 413 });
	try {
		return { message: JSON.parse(text) };
	} catch {
		return Response.json(
			{
				jsonrpc: "2.0",
				id: null,
				error: { code: -32700, message: "Parse error." },
			},
			{ status: 400 },
		);
	}
}

/**
 * In the edge Worker: one MCP message for a turn whose step runs on a box
 * (claude-relay.ts). Calls are held here while the box runs them; the
 * chat's object only passes them on.
 */
export async function answerRelayedClaudeCodeMcp(
	request: Request,
	chat: { fetch(request: Request): Promise<Response> },
	listedTools: () => Promise<readonly McpToolDefinition[] | null>,
	grantHeader: string,
): Promise<Response> {
	const parsed = await mcpRequestMessage(request);
	if (parsed instanceof Response) return parsed;
	const reply = await handleMcpMessage(parsed.message, {
		tools: () => relayedClaudeTools(listedTools),
		call: (name, args, invocationId) =>
			relayClaudeCall(chat, grantHeader, {
				name,
				args,
				...(invocationId === undefined ? {} : { invocationId }),
				timeoutMs: CLAUDE_CODE_CALL_TIMEOUT_MS,
				graceMs: 0,
			}),
		// The box knows whether the user sent a message meanwhile.
		inbox: async () => {
			const reply = await relayClaudeCall(chat, grantHeader, {
				name: CLAUDE_CODE_INBOX_CALL,
				args: {},
				timeoutMs: 20_000,
				graceMs: 120_000,
			});
			return reply.isError ? "" : reply.text;
		},
	});
	return reply.body === undefined
		? new Response(null, { status: reply.status })
		: Response.json(reply.body, { status: reply.status });
}

/**
 * Inside the chat's Durable Object: one MCP message for the turn the grant
 * names. Tools run in the turn's step (claude-code-bridge.ts).
 */
export async function answerClaudeCodeMcp(
	request: Request,
	env: EdgeExecutorEnvironment,
	expectedName: (name: string) => boolean,
): Promise<Response> {
	if (!claudeSubscriptionEnabled()) return new Response(null, { status: 404 });
	const secrets = claudeCodeSecrets.safeParse(env);
	if (!secrets.success) return new Response(null, { status: 503 });
	const grant = await verifyClaudeCodeGrant(
		secrets.data.GIT_PROXY_SECRET,
		presentedClaudeCodeGrant(request.headers),
	);
	if (!grant || !expectedName(modelConversationName(grant)))
		return new Response(null, { status: 401 });
	const parsed = await mcpRequestMessage(request);
	if (parsed instanceof Response) return parsed;
	const reply = await handleMcpMessage(parsed.message, {
		tools: async () => (await claudeCodeBridgeTools(grant.turnId)) ?? [],
		call: (name, args, invocationId) =>
			requestClaudeCodeCall(
				grant.turnId,
				name,
				args,
				undefined,
				undefined,
				invocationId,
			),
		// Asked before the run stops, and after a tool call when the run's feed
		// announced a sent message (or there is no feed: an older runner, a
		// lost socket; claude-feed.ts). Answered here at once unless the turn's
		// heartbeat (in this object) saw a sent message or cannot rule one out.
		// The step takes it once picked up, so a slow answer is waited for.
		inbox: async () => {
			if (!queuedMessageMaybeSent(grant.sessionId)) return "";
			const reply = await requestClaudeCodeCall(
				grant.turnId,
				CLAUDE_CODE_INBOX_CALL,
				{},
				20_000,
				120_000,
			);
			return reply.isError ? "" : reply.text;
		},
	});
	return reply.body === undefined
		? new Response(null, { status: reply.status })
		: Response.json(reply.body, { status: reply.status });
}
