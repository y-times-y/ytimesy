import { describe, expect, it } from "vitest";
import { SessionItemId } from "#/domain/ids";
import {
	sessionItemFromAppServerItem,
	sessionItemsFromAppServerNotifications,
	sessionItemsFromDaemonStatus,
	sessionTurnStatusFromDaemon,
} from "./app-server-items";

describe("sessionItemFromAppServerItem", () => {
	it("reads a user message from content parts, not a role label", () => {
		expect(
			sessionItemFromAppServerItem({
				id: "item_user_1",
				type: "userMessage",
				content: [{ type: "text", text: "Run echo hello-from-ytimesy" }],
			}),
		).toEqual({
			kind: "userMessage",
			id: SessionItemId("item_user_1"),
			text: "Run echo hello-from-ytimesy",
		});
	});

	it("keeps reasoning summaries off the agent message", () => {
		expect(
			sessionItemFromAppServerItem({
				id: "item_reason_1",
				type: "reasoning",
				summary: [{ text: "I should run the requested command." }],
			}),
		).toEqual({
			kind: "reasoning",
			id: SessionItemId("item_reason_1"),
			summaries: ["I should run the requested command."],
		});
	});

	it("maps a completed commandExecution with output and exit code", () => {
		expect(
			sessionItemFromAppServerItem({
				id: "item_cmd_1",
				type: "commandExecution",
				command: ["echo", "hello-from-ytimesy"],
				cwd: "/tmp",
				status: "completed",
				aggregatedOutput: "hello-from-ytimesy\n",
				exitCode: 0,
			}),
		).toEqual({
			kind: "commandExecution",
			id: SessionItemId("item_cmd_1"),
			command: "echo hello-from-ytimesy",
			cwd: "/tmp",
			status: "completed",
			output: "hello-from-ytimesy\n",
			exitCode: 0,
		});
	});

	it("maps MCP and dynamic tool calls by name and status", () => {
		expect(
			sessionItemFromAppServerItem({
				id: "item_mcp_1",
				type: "mcpToolCall",
				server: "github",
				tool: "search_code",
				status: "in_progress",
			}),
		).toEqual({
			kind: "mcpToolCall",
			id: SessionItemId("item_mcp_1"),
			server: "github",
			tool: "search_code",
			status: "inProgress",
		});
		expect(
			sessionItemFromAppServerItem({
				id: "item_dyn_1",
				type: "dynamic_tool_call",
				tool: "read_file",
				status: "failed",
			}),
		).toEqual({
			kind: "dynamicToolCall",
			id: SessionItemId("item_dyn_1"),
			tool: "read_file",
			status: "failed",
		});
	});

	it("maps a fileChange with unified-diff line counts", () => {
		expect(
			sessionItemFromAppServerItem({
				id: "item_files_1",
				type: "fileChange",
				status: "completed",
				changes: [
					{
						path: "src/app.ts",
						kind: "update",
						diff: "--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1,2 @@\n keep\n+added\n",
					},
				],
			}),
		).toEqual({
			kind: "fileChange",
			id: SessionItemId("item_files_1"),
			status: "completed",
			changes: [
				{
					path: "src/app.ts",
					change: "update",
					additions: 1,
					deletions: 0,
				},
			],
		});
	});

	it("preserves unknown item types instead of dropping them", () => {
		expect(
			sessionItemFromAppServerItem({
				id: "item_sleep_1",
				type: "sleep",
				durationMs: 4000,
			}),
		).toEqual({
			kind: "unknown",
			id: SessionItemId("item_sleep_1"),
			type: "sleep",
		});
	});
});

describe("sessionItemsFromAppServerNotifications", () => {
	it("reduces started, delta, and completed notifications to one item each", () => {
		expect(
			sessionItemsFromAppServerNotifications([
				{
					method: "item/started",
					params: {
						item: {
							id: "item_cmd_1",
							type: "commandExecution",
							command: "echo hello-from-ytimesy",
							cwd: "/tmp",
							status: "inProgress",
						},
					},
				},
				{
					method: "item/commandExecution/outputDelta",
					params: { itemId: "item_cmd_1", delta: "hello-from-ytimesy\n" },
				},
				{
					method: "item/started",
					params: {
						item: { id: "item_msg_1", type: "agentMessage", text: "" },
					},
				},
				{
					method: "item/agentMessage/delta",
					params: { itemId: "item_msg_1", delta: "pong" },
				},
				{
					method: "item/completed",
					params: {
						item: {
							id: "item_cmd_1",
							type: "commandExecution",
							command: "echo hello-from-ytimesy",
							cwd: "/tmp",
							status: "completed",
							aggregatedOutput: "hello-from-ytimesy\n",
							exitCode: 0,
						},
					},
				},
				{
					method: "item/completed",
					params: {
						item: { id: "item_msg_1", type: "agentMessage", text: "pong" },
					},
				},
			]),
		).toEqual([
			{
				kind: "commandExecution",
				id: SessionItemId("item_cmd_1"),
				command: "echo hello-from-ytimesy",
				cwd: "/tmp",
				status: "completed",
				output: "hello-from-ytimesy\n",
				exitCode: 0,
			},
			{
				kind: "agentMessage",
				id: SessionItemId("item_msg_1"),
				text: "pong",
			},
		]);
	});

	it("uses turn/completed items as the authoritative list when present", () => {
		expect(
			sessionItemsFromAppServerNotifications([
				{
					method: "item/started",
					params: {
						item: {
							id: "item_reason_1",
							type: "reasoning",
							summary: [],
						},
					},
				},
				{
					method: "turn/completed",
					params: {
						turn: {
							id: "turn_1",
							items: [
								{
									id: "item_user_1",
									type: "userMessage",
									content: [{ type: "text", text: "hi" }],
								},
								{
									id: "item_reason_1",
									type: "reasoning",
									summary: ["Checking the request."],
								},
								{ id: "item_msg_1", type: "agentMessage", text: "hello" },
							],
						},
					},
				},
			]),
		).toEqual([
			{
				kind: "reasoning",
				id: SessionItemId("item_reason_1"),
				summaries: ["Checking the request."],
			},
			{
				kind: "userMessage",
				id: SessionItemId("item_user_1"),
				text: "hi",
			},
			{
				kind: "agentMessage",
				id: SessionItemId("item_msg_1"),
				text: "hello",
			},
		]);
	});
});

describe("sessionItemsFromDaemonStatus", () => {
	it("prefers stored app-server items over flattened You/Codex messages", () => {
		expect(
			sessionItemsFromDaemonStatus({
				items: [{ id: "item_1", type: "agentMessage", text: "pong" }],
				messages: [{ id: "assistant-1", role: "assistant", text: "pong" }],
			}),
		).toEqual([
			{
				kind: "agentMessage",
				id: SessionItemId("item_1"),
				text: "pong",
			},
		]);
	});

	it("falls back to legacy messages when the daemon has not stored items yet", () => {
		expect(
			sessionItemsFromDaemonStatus({
				messages: [
					{ id: "user-1", role: "user", text: "hi" },
					{ id: "assistant-1", role: "assistant", text: "pong" },
				],
			}),
		).toEqual([
			{ kind: "userMessage", id: SessionItemId("user-1"), text: "hi" },
			{ kind: "agentMessage", id: SessionItemId("assistant-1"), text: "pong" },
		]);
	});
});

describe("sessionTurnStatusFromDaemon", () => {
	it("does not invent a running turn from a missing field", () => {
		expect(sessionTurnStatusFromDaemon(undefined, null)).toBe("idle");
		expect(sessionTurnStatusFromDaemon("running", "started")).toBe("running");
		expect(sessionTurnStatusFromDaemon(undefined, "timeout")).toBe("failed");
	});
});
