import { expect, it } from "vitest";
import { shouldPollAgentTasks } from "./agent-task";
import { agentTodosFromUnknown } from "./agent-todos";

it("discovers tasks from an empty list while the lead runs and follows waiting children", () => {
	expect(shouldPollAgentTasks("running", [])).toBe(true);
	expect(shouldPollAgentTasks("completed", [{ status: "waiting" }])).toBe(true);
	expect(shouldPollAgentTasks("completed", [{ status: "done" }])).toBe(false);
});

import {
	collectAppServerItems,
	sessionItemFromAppServerItem,
} from "../server/adapters/codex/app-server-items";
import { sessionItemsFromClaudeStream } from "./claude-stream";

it("normalizes checklist statuses without inferring completion", () => {
	expect(
		agentTodosFromUnknown([
			{ step: "Inspect", status: "pending" },
			{ content: "Test", status: "completed" },
			{ text: "Bad", status: "unknown" },
			null,
		]),
	).toEqual([
		{ text: "Inspect", status: "pending" },
		{ text: "Test", status: "completed" },
	]);
});
it("replaces the Codex turn checklist without requiring an item ID", () => {
	const notifications = ["pending", "completed"].map((status) => ({
		method: "turn/plan/updated",
		params: { turnId: "one", plan: [{ step: "Test", status }] },
	}));
	const items = collectAppServerItems(notifications).map(
		sessionItemFromAppServerItem,
	);
	expect(items).toHaveLength(1);
	expect(items[0]).toMatchObject({
		kind: "plan",
		todos: [{ text: "Test", status: "completed" }],
	});
});
it("updates Claude partial tool starts from the complete TodoWrite input", () => {
	const stream = [
		{
			type: "content_block_start",
			content_block: {
				type: "tool_use",
				id: "todo",
				name: "TodoWrite",
				input: {},
			},
		},
		{
			type: "assistant",
			message: {
				content: [
					{
						type: "tool_use",
						id: "todo",
						name: "TodoWrite",
						input: { todos: [{ content: "Test", status: "completed" }] },
					},
				],
			},
		},
	]
		.map((event) => JSON.stringify(event))
		.join("\n");
	expect(sessionItemsFromClaudeStream(stream)).toEqual([
		{
			kind: "plan",
			id: "todo",
			text: "",
			todos: [{ text: "Test", status: "completed" }],
		},
	]);
});
