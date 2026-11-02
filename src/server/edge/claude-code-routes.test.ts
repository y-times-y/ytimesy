import { afterEach, describe, expect, it, vi } from "vitest";
import { issueClaudeCodeGrant } from "#/domain/claude-code-grant";
import { modelConversationName } from "#/domain/model-conversation-routing";
import {
	closeClaudeCodeBridge,
	publishClaudeCodeTools,
	runClaudeCodeCall,
	takeClaudeCodeCalls,
} from "../services/claude-code-bridge";
import { answerClaudeCodeMcp, routeClaudeCodeEdge } from "./claude-code-routes";
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
