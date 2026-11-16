import { describe, expect, it } from "vitest";
import {
	claudeCodeContextTokens,
	claudeCodeContextWindow,
	claudeCodeEffects,
	claudeCodeFailure,
	claudeCodeProjectDirectory,
	claudeCodePrompt,
} from "./claude-code-stream";

const names = new Map([["toolu_1", "Bash"]]);
const context = { toolName: (id: string) => names.get(id) };
const line = (value: unknown) => JSON.stringify(value);

describe("Claude Code stream-json", () => {
	it("reads the session and failed MCP servers from init", () => {
		expect(
			claudeCodeEffects(
				line({
					type: "system",
					subtype: "init",
					session_id: "33333333-3333-4333-8333-333333333333",
					mcp_servers: [{ name: "ytimesy", status: "failed" }],
				}),
				"0",
				context,
			),
		).toEqual([
			{
				kind: "session",
				sessionId: "33333333-3333-4333-8333-333333333333",
				failedMcpServers: ["ytimesy"],
			},
		]);
	});

	it("maps assistant text, thinking and tool calls to timeline events", () => {
		const effects = claudeCodeEffects(
			line({
				type: "assistant",
				parent_tool_use_id: null,
				message: {
					id: "msg_1",
					content: [
						{ type: "thinking", thinking: "Plan it." },
						{ type: "text", text: "Running tests." },
						{
							type: "tool_use",
							id: "toolu_1",
							name: "Bash",
							input: { command: "npm test" },
						},
					],
				},
			}),
			"120",
			context,
		);
		expect(effects).toEqual([
			{
				kind: "event",
				event: { type: "reasoning-delta", id: "cc-120-0", text: "Plan it." },
			},
			{
				kind: "event",
				event: { type: "reasoning-end", id: "cc-120-0", durationSeconds: 0 },
			},
			{
				kind: "event",
				event: { type: "text-delta", id: "cc-120-1", text: "Running tests." },
			},
			{
				kind: "event",
				event: {
					type: "tool-call",
					id: "toolu_1",
					name: "Bash",
					input: { command: "npm test" },
				},
			},
		]);
	});

	it("shows TodoWrite as the plan and leaves ytimesy's own tools to the bridge", () => {
		const effects = claudeCodeEffects(
			line({
				type: "assistant",
				message: {
					content: [
						{
							type: "tool_use",
							id: "toolu_2",
							name: "TodoWrite",
							input: {
								todos: [
									{ content: "Read code", status: "completed" },
									{ content: "Fix bug", status: "in_progress" },
									{ content: "", status: "pending" },
								],
							},
						},
						{
							type: "tool_use",
							id: "toolu_3",
							name: "mcp__ytimesy__agent",
							input: {},
						},
					],
				},
			}),
			"7",
			context,
		);
		expect(effects).toEqual([
			{
				kind: "plan",
				plan: [
					{ step: "Read code", status: "completed" },
					{ step: "Fix bug", status: "in_progress" },
				],
			},
		]);
	});

	it("maps tool results to the call they answer, skipping unknown calls", () => {
		const effects = claudeCodeEffects(
			line({
				type: "user",
				message: {
					content: [
						{
							type: "tool_result",
							tool_use_id: "toolu_1",
							content: [{ type: "text", text: "1 passed" }],
							is_error: true,
						},
						{ type: "tool_result", tool_use_id: "toolu_3", content: "ok" },
					],
				},
			}),
			"9",
			context,
		);
		expect(effects).toEqual([
			{
				kind: "event",
				event: {
					type: "tool-result",
					id: "toolu_1",
					name: "Bash",
					output: "1 passed",
					failed: true,
				},
			},
		]);
	});

	it("keeps Claude Code's own subagent traffic out of the timeline", () => {
		expect(
			claudeCodeEffects(
				line({
					type: "assistant",
					parent_tool_use_id: "toolu_9",
					message: { content: [{ type: "text", text: "inner" }] },
				}),
				"1",
				context,
			),
		).toEqual([]);
	});

	it("reads results, usage and failures", () => {
		const [ok] = claudeCodeEffects(
			line({
				type: "result",
				subtype: "success",
				is_error: false,
				result: "Done.",
				session_id: "s",
				usage: {
					input_tokens: 10,
					output_tokens: 5,
					cache_read_input_tokens: 100,
					cache_creation_input_tokens: 20,
				},
			}),
			"3",
			context,
		);
		expect(ok).toEqual({
			kind: "result",
			result: {
				ok: true,
				subtype: "success",
				text: "Done.",
				sessionId: "s",
				usage: {
					inputTokens: 130,
					outputTokens: 5,
					uncachedInputTokens: 10,
					cacheReadTokens: 100,
					cacheWriteTokens: 20,
				},
				// A result without modelUsage names no context window.
				contextWindow: null,
			},
		});
		const [limited] = claudeCodeEffects(
			line({
				type: "result",
				subtype: "success",
				is_error: true,
				result: "Claude AI usage limit reached|1900000000",
			}),
			"4",
			context,
		);
		expect(limited).toMatchObject({
			result: {
				ok: false,
				failure: "usage-limit",
				resetsAt: 1_900_000_000_000,
			},
		});
		expect(
			claudeCodeFailure("API Error: 401 OAuth token has expired").failure,
		).toBe("refused");
		expect(claudeCodeFailure("Something broke").failure).toBe("error");
	});

	it("reads Claude Code's own API error lines as the run's failure, never as the reply", () => {
		const refused =
			'Failed to authenticate. API Error: 403 {"type":"error","error":{"type":"permission_error","message":"This turn\'s access ended."}}';
		// As the CLI writes it: an assistant line the SDK marks with `error`.
		expect(
			claudeCodeEffects(
				line({
					type: "assistant",
					parent_tool_use_id: null,
					error: "authentication_failed",
					message: {
						model: "<synthetic>",
						role: "assistant",
						content: [{ type: "text", text: refused }],
					},
				}),
				"9",
				context,
			),
		).toEqual([{ kind: "api-error", text: refused }]);
		// Older CLIs leave the mark out; the wording still gives it away.
		expect(
			claudeCodeEffects(
				line({
					type: "assistant",
					message: {
						content: [{ type: "text", text: "API Error: 529 Overloaded" }],
					},
				}),
				"10",
				context,
			),
		).toEqual([{ kind: "api-error", text: "API Error: 529 Overloaded" }]);
		// A reply that merely mentions an error is the agent's own text.
		expect(
			claudeCodeEffects(
				line({
					type: "assistant",
					message: {
						content: [{ type: "text", text: "The log shows API Error: 500." }],
					},
				}),
				"11",
				context,
			)[0],
		).toMatchObject({ kind: "event", event: { type: "text-delta" } });
		// A result that only repeats the error never passes as an answer.
		const [result] = claudeCodeEffects(
			line({
				type: "result",
				subtype: "success",
				is_error: false,
				result: refused,
			}),
			"12",
			context,
		);
		expect(result).toMatchObject({
			kind: "result",
			result: { ok: false, failure: "refused" },
		});
		expect(claudeCodeFailure("API Error: 429 rate_limit_error").failure).toBe(
			"rate-limited",
		);
		expect(claudeCodeFailure("API Error: 529 Overloaded").failure).toBe(
			"overloaded",
		);
		expect(claudeCodeFailure("API Error: 500 Internal error").failure).toBe(
			"outage",
		);
	});

	it("ignores lines that are not JSON", () => {
		expect(claudeCodeEffects("not json", "0", context)).toEqual([]);
	});
});

describe("Claude Code prompts", () => {
	const messages = [
		{ role: "user", content: "Add a login page." },
		{ role: "assistant", content: "Added it." },
		{
			role: "user",
			content: [
				{ type: "text", text: "Now add tests." },
				{ type: "image", image: "x" },
			],
		},
		{ role: "user", content: "Runtime notice." },
	];

	it("sends only what is new when the session resumes", () => {
		expect(claudeCodePrompt(messages, true)).toBe(
			"Now add tests.\n\n[An attached file is in the chat's attachments folder.]\n\nRuntime notice.",
		);
	});

	it("carries the conversation into a new session", () => {
		const prompt = claudeCodePrompt(messages, false);
		expect(prompt).toContain("User: Add a login page.");
		expect(prompt).toContain("Assistant: Added it.");
		expect(prompt.endsWith("Runtime notice.")).toBe(true);
	});

	it("names the project directory as Claude Code does", () => {
		expect(claudeCodeProjectDirectory("/home/ubuntu/my.repo")).toBe(
			"-home-ubuntu-my-repo",
		);
	});
});

// The usage and modelUsage shapes below are copied from a real run's output.
describe("Claude Code context size", () => {
	const realUsage = {
		input_tokens: 4,
		cache_creation_input_tokens: 3784,
		cache_read_input_tokens: 17250,
		output_tokens: 8,
		service_tier: "standard",
	};

	it("counts everything a model call read and wrote", () => {
		expect(claudeCodeContextTokens(realUsage)).toBe(4 + 3784 + 17250 + 8);
		expect(claudeCodeContextTokens({})).toBeNull();
		expect(claudeCodeContextTokens(undefined)).toBeNull();
	});

	it("reports the call's context on a top-level assistant line", () => {
		const effects = claudeCodeEffects(
			line({
				type: "assistant",
				message: {
					content: [{ type: "text", text: "Done." }],
					usage: realUsage,
				},
			}),
			"0",
			context,
		);
		expect(effects).toContainEqual({ kind: "context", totalTokens: 21046 });
	});

	it("leaves a subagent's calls out of the chat's context", () => {
		expect(
			claudeCodeEffects(
				line({
					type: "assistant",
					parent_tool_use_id: "toolu_1",
					message: { content: [], usage: realUsage },
				}),
				"0",
				context,
			),
		).toEqual([]);
	});

	it("reads the model's context window from the result, the largest when several models ran", () => {
		expect(
			claudeCodeContextWindow({
				"claude-sonnet-5-5": { inputTokens: 6, contextWindow: 1_000_000 },
			}),
		).toBe(1_000_000);
		expect(
			claudeCodeContextWindow({
				a: { contextWindow: 200_000 },
				b: { contextWindow: 1_000_000 },
			}),
		).toBe(1_000_000);
		expect(claudeCodeContextWindow({ a: {} })).toBeNull();
		expect(claudeCodeContextWindow(undefined)).toBeNull();
		const [result] = claudeCodeEffects(
			line({
				type: "result",
				subtype: "success",
				is_error: false,
				result: "ok",
				usage: { input_tokens: 1, output_tokens: 1 },
				modelUsage: { "claude-sonnet-5-5": { contextWindow: 1_000_000 } },
			}),
			"1",
			context,
		);
		expect(result).toMatchObject({
			kind: "result",
			result: { contextWindow: 1_000_000 },
		});
	});
});

describe("Claude Code stream-json with box tools", () => {
	const assistant = (name: string, input: unknown) =>
		line({
			type: "assistant",
			message: {
				content: [{ type: "tool_use", id: "toolu_box", name, input }],
			},
		});
	const boxTools = new Set(["bash", "read"]);

	it("shows the calls the runner box ran itself, under the tool's own name", () => {
		expect(
			claudeCodeEffects(
				assistant("mcp__ytimesy__read", { path: "a.ts" }),
				"k",
				{ ...context, boxTools },
			),
		).toEqual([
			{
				kind: "event",
				event: {
					type: "tool-call",
					id: "toolu_box",
					name: "read",
					input: { path: "a.ts" },
				},
			},
		]);
	});

	it("leaves the calls the edge's bridge shows: other tools, edge-bound calls, runs without box tools", () => {
		for (const [name, input, tools] of [
			["mcp__ytimesy__agent", {}, boxTools],
			[
				"mcp__ytimesy__bash",
				{ command: "npm start", background: true },
				boxTools,
			],
			["mcp__ytimesy__bash", { command: "ytimesy-browser open x" }, boxTools],
			["mcp__ytimesy__read", { path: "a.ts" }, undefined],
		] as const)
			expect(
				claudeCodeEffects(assistant(name, input), "k", {
					...context,
					...(tools ? { boxTools: tools } : {}),
				}),
			).toEqual([]);
	});
});
