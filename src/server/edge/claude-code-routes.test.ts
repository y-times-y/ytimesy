import { afterEach, describe, expect, it, vi } from "vitest";
import { issueClaudeCodeGrant } from "#/domain/claude-code-grant";
import { modelConversationName } from "#/domain/model-conversation-routing";
import {
	closeClaudeCodeBridge,
	publishClaudeCodeTools,
	runClaudeCodeCall,
	takeClaudeCodeCalls,
} from "../services/claude-code-bridge";
import {
	answerClaudeCodeMcp,
	forwardClaudeCodeMcp,
	routeClaudeCodeEdge,
} from "./claude-code-routes";
import type { EdgeExecutorEnvironment } from "./environment";

vi.mock("../adapters/claude-subscription", () => ({
	authorizeClaudeCodeProxy: vi.fn(async () => ({ kind: "ok", token: "real" })),
	recordClaudeCodeUpstream: vi.fn(),
}));
vi.mock("../adapters/database-scope", () => ({
	withDatabaseScope: (_: string, run: () => unknown) => run(),
}));

const secret = "s".repeat(40);
const scope = {
	userId: "u1",
	sessionId: "11111111-1111-4111-8111-111111111111",
	turnId: "22222222-2222-4222-8222-222222222222",
};
const env = (fetch = vi.fn()) =>
	({
		GIT_PROXY_SECRET: secret,
		HYPERDRIVE: { connectionString: "postgres://x" },
		MODEL_CONVERSATIONS: { getByName: vi.fn(() => ({ fetch })) },
	}) as unknown as EdgeExecutorEnvironment;

afterEach(() => {
	delete process.env.YTIMESY_CLAUDE_SUBSCRIPTION_ENABLED;
});

describe("Claude Code edge routes", () => {
	it("do not exist while the switch is off", async () => {
		const grant = await issueClaudeCodeGrant(secret, scope);
		for (const path of ["/claude-code/v1/messages", "/claude-code/mcp"]) {
			const response = await routeClaudeCodeEdge(
				new Request(`https://edge.example${path}`, {
					method: "POST",
					headers: { authorization: `Bearer ${grant}` },
					body: "{}",
				}),
				env(),
			);
			expect(response.status).toBe(404);
		}
	});

	it("send MCP requests to the chat that runs the turn", async () => {
		process.env.YTIMESY_CLAUDE_SUBSCRIPTION_ENABLED = "1";
		const grant = await issueClaudeCodeGrant(secret, scope);
		const forwarded = vi.fn(async () => new Response("{}"));
		const edge = env(forwarded);
		await routeClaudeCodeEdge(
			new Request("https://edge.example/claude-code/mcp", {
				method: "POST",
				headers: { authorization: `Bearer ${grant}` },
				body: "{}",
			}),
			edge,
		);
		expect(
			vi.mocked(edge.MODEL_CONVERSATIONS.getByName).mock.calls[0]?.[0],
		).toBe(modelConversationName(scope));
		expect(forwarded).toHaveBeenCalledTimes(1);
		const unsigned = await routeClaudeCodeEdge(
			new Request("https://edge.example/claude-code/mcp", {
				method: "POST",
				body: "{}",
			}),
			edge,
		);
		expect(unsigned.status).toBe(401);
	});

	it("answer MCP inside the chat's object from the running step", async () => {
		process.env.YTIMESY_CLAUDE_SUBSCRIPTION_ENABLED = "1";
		const grant = await issueClaudeCodeGrant(secret, scope);
		const { tool } = await import("ai");
		const { z } = await import("zod");
		const tools = {
			agent: tool({
				description: "Start a helper.",
				inputSchema: z.object({ brief: z.string() }),
				execute: async () => "started",
			}),
		};
		publishClaudeCodeTools(scope.turnId, [
			{ name: "agent", description: "Start a helper.", inputSchema: {} },
		]);
		const request = (body: unknown, name = modelConversationName(scope)) =>
			answerClaudeCodeMcp(
				new Request("https://chat.internal/claude-code/mcp", {
					method: "POST",
					headers: { authorization: `Bearer ${grant}` },
					body: JSON.stringify(body),
				}),
				env(),
				(expected) => expected === name,
			);
		const list = await request({ jsonrpc: "2.0", id: 1, method: "tools/list" });
		expect(await list.json()).toMatchObject({
			result: { tools: [{ name: "agent" }] },
		});
		const calling = request({
			jsonrpc: "2.0",
			id: 2,
			method: "tools/call",
			params: { name: "agent", arguments: { brief: "x" } },
		});
		// The step's poll loop takes the call and runs it in its own context.
		for (let tries = 0; tries < 50; tries++) {
			const calls = takeClaudeCodeCalls(scope.turnId);
			if (calls.length) {
				for (const call of calls)
					await runClaudeCodeCall(scope.turnId, call, {
						tools,
						onEvent: async () => {},
						signal: new AbortController().signal,
					});
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		expect(await (await calling).json()).toMatchObject({
			result: { content: [{ type: "text", text: "started" }], isError: false },
		});
		// Another chat's object refuses the grant.
		expect(
			(await request({ jsonrpc: "2.0", id: 3, method: "ping" }, "other"))
				.status,
		).toBe(401);
		closeClaudeCodeBridge(scope.turnId);
	});
});

describe("an MCP message when the chat's object resets under it", () => {
	// What the runtime throws to the Worker (production, 2026-11-21 and -23).
	const memoryReset = () =>
		new Error(
			"Durable Object's isolate exceeded its memory limit and was reset.",
		);
	const call = (name: string, args: Record<string, unknown> = {}) =>
		JSON.stringify({
			jsonrpc: "2.0",
			id: 7,
			method: "tools/call",
			params: { name, arguments: args },
		});
	const post = (body: string, authorization = "Bearer g") =>
		new Request("https://edge.example/claude-code/mcp", {
			method: "POST",
			headers: { authorization },
			body,
		});
	const answered = () =>
		Response.json({
			jsonrpc: "2.0",
			id: 7,
			result: { content: [{ type: "text", text: "2 threads" }] },
		});

	it("is sent again for a read-only tool, and the run gets the answer", async () => {
		process.env.YTIMESY_CLAUDE_SUBSCRIPTION_ENABLED = "1";
		const grant = await issueClaudeCodeGrant(secret, scope);
		const bodies: string[] = [];
		const fetch = vi.fn(async (request: Request) => {
			bodies.push(await request.text());
			if (bodies.length === 1) throw memoryReset();
			return answered();
		});
		const response = await routeClaudeCodeEdge(
			post(call("threads"), `Bearer ${grant}`),
			env(fetch),
		);
		// Before: the reset escaped to the Worker's catch-all, an empty 503
		// ("Error POSTing to endpoint:" in the run).
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			result: { content: [{ text: "2 threads" }] },
		});
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(bodies[1]).toBe(bodies[0]);
		expect(fetch.mock.calls[1]?.[0].headers.get("authorization")).toBe(
			`Bearer ${grant}`,
		);
	});

	it("is sent again for a keyed send and for the protocol's own messages", async () => {
		for (const body of [
			call("message_thread", { id: "t", text: "go", mode: "steer" }),
			call("start_thread", { title: "a", brief: "b" }),
			JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
		]) {
			const fetch = vi
				.fn()
				.mockResolvedValueOnce(new Response(null, { status: 503 }))
				.mockResolvedValueOnce(answered());
			const response = await forwardClaudeCodeMcp(
				post(body),
				{ fetch },
				async () => {},
			);
			expect(response.status).toBe(200);
			expect(fetch).toHaveBeenCalledTimes(2);
		}
	});

	it("is not sent twice when it may have changed something, and says what failed", async () => {
		for (const name of ["bash", "stop_thread", "message_thread"]) {
			const fetch = vi.fn(async () => {
				throw memoryReset();
			});
			const response = await forwardClaudeCodeMcp(
				post(call(name, { id: "t", text: "stop", mode: "interrupt" })),
				{ fetch },
				async () => {},
			);
			expect(fetch).toHaveBeenCalledTimes(1);
			expect(response.status).toBe(200);
			const reply = (await response.json()) as {
				id: number;
				result: { isError: boolean; content: { text: string }[] };
			};
			expect(reply.id).toBe(7);
			expect(reply.result.isError).toBe(true);
			const text = reply.result.content[0]?.text ?? "";
			expect(text).toContain(`tools/call ${name}`);
			expect(text).toContain("Durable Object");
			expect(text).toContain("ran out of memory");
			expect(text).toContain("outcome is unknown");
		}
	});

	it("gives up after a few tries with the hop and the cause, never an empty error", async () => {
		const pauses: number[] = [];
		const fetch = vi.fn(async () => {
			throw new Error("Durable Object reset because its code was updated.");
		});
		const response = await forwardClaudeCodeMcp(
			post(call("thread", { id: "t" })),
			{ fetch },
			async (ms) => {
				pauses.push(ms);
			},
		);
		expect(fetch).toHaveBeenCalledTimes(4);
		expect(pauses).toEqual([250, 1_000, 2_500]);
		const reply = (await response.json()) as {
			result: { isError: boolean; content: { text: string }[] };
		};
		expect(reply.result.isError).toBe(true);
		expect(reply.result.content[0]?.text).toMatch(
			/restarted for a deploy \(tried 4 times\).*safe to repeat/,
		);
	});

	it("never shows the run what an object's own error said", async () => {
		const fetch = vi.fn(async () => {
			throw new Error(
				"password authentication failed for user postgres:s3cret",
			);
		});
		const response = await forwardClaudeCodeMcp(
			post(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "initialize" })),
			{ fetch },
			async () => {},
		);
		const text = await response.text();
		expect(text).toContain("internal error");
		expect(text).not.toContain("s3cret");
	});
});

describe("Claude plan usage writes", () => {
	it("write once per user per 15 seconds, at once on a status change", async () => {
		const { shouldWritePlanUsage } = await import("./claude-code-routes");
		expect(shouldWritePlanUsage("throttle-user", "allowed", 1_000)).toBe(true);
		expect(shouldWritePlanUsage("throttle-user", "allowed", 5_000)).toBe(false);
		expect(shouldWritePlanUsage("throttle-user", "rejected", 6_000)).toBe(true);
		expect(shouldWritePlanUsage("throttle-user", "rejected", 22_000)).toBe(
			true,
		);
		expect(shouldWritePlanUsage("other-user", "rejected", 22_000)).toBe(true);
	});
});
