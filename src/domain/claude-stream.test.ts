import { describe, expect, it } from "vitest";
import { SessionItemId } from "./ids";
import {
	claudeTurnItemsFromStream,
	sessionItemsFromClaudeStream,
} from "./claude-stream";

describe("sessionItemsFromClaudeStream", () => {
	it("streams thinking and tool calls before the final text", () => {
		expect(
			sessionItemsFromClaudeStream(`
{"type":"system","subtype":"init"}
{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"I should inspect the timeline first."}]}}
{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_read","name":"Read","input":{"file_path":"src/features/sessions/session-timeline.tsx"}}]}}
{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_read","content":"export function SessionTimeline"}]}}
{"type":"assistant","message":{"content":[{"type":"text","text":"The timeline already renders live items."}]}}
{"type":"result","result":"The timeline already renders live items."}
`),
		).toMatchObject([
			{
				kind: "reasoning",
				summaries: ["I should inspect the timeline first."],
			},
			{
				kind: "dynamicToolCall",
				tool: "Read session-timeline.tsx",
				status: "completed",
			},
			{
				kind: "agentMessage",
				text: "The timeline already renders live items.",
			},
		]);
	});

	it("shows Bash as a live shell command", () => {
		expect(
			sessionItemsFromClaudeStream(
				`{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_bash","name":"Bash","input":{"command":"ls","workdir":"/tmp"}}]}}`,
			),
		).toMatchObject([
			{
				kind: "commandExecution",
				command: "ls",
				cwd: "/tmp",
				status: "inProgress",
			},
		]);
	});

	it("marks token deltas as streaming and clears the caret on the finished text", () => {
		expect(
			sessionItemsFromClaudeStream(`
{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"pong"}}}
`),
		).toMatchObject([{ kind: "agentMessage", text: "pong", streaming: true }]);
		expect(
			sessionItemsFromClaudeStream(`
{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"pong"}}}
{"type":"stream_event","event":{"type":"content_block_stop"}}
{"type":"assistant","message":{"content":[{"type":"text","text":"pong"}]}}
{"type":"result","result":"pong"}
`),
		).toEqual([
			expect.objectContaining({
				kind: "agentMessage",
				text: "pong",
			}),
		]);
		expect(
			sessionItemsFromClaudeStream(`
{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"pong"}}}
{"type":"stream_event","event":{"type":"content_block_stop"}}
{"type":"assistant","message":{"content":[{"type":"text","text":"pong"}]}}
{"type":"result","result":"pong"}
`)[0],
		).not.toHaveProperty("streaming", true);
	});

	it("keeps thinking deltas even when the last row is a tool", () => {
		expect(
			sessionItemsFromClaudeStream(`
{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_ls","name":"Bash","input":{"command":"ls"}}]}}
{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"Need the tree."}}
`),
		).toMatchObject([
			{ kind: "commandExecution", command: "ls" },
			{ kind: "reasoning", summaries: ["Need the tree."] },
		]);
	});

	it("shows thinking deltas before the complete assistant message", () => {
		expect(
			sessionItemsFromClaudeStream(`
{"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"thinking"}}}
{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"Look at "}}}
{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"the tree."}}}
{"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"tool_use","id":"toolu_ls","name":"Bash","input":{"command":"ls"}}}}
{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"Look at the tree."},{"type":"tool_use","id":"toolu_ls","name":"Bash","input":{"command":"ls"}}]}}
`),
		).toMatchObject([
			{ kind: "reasoning", summaries: ["Look at the tree."] },
			{ kind: "commandExecution", command: "ls", status: "inProgress" },
		]);
	});

	it("keeps an incomplete last line from breaking earlier events", () => {
		expect(
			sessionItemsFromClaudeStream(
				`{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"working"}]}}\n{"type":"assistant","message":{"content":[`,
			),
		).toMatchObject([{ kind: "reasoning", summaries: ["working"] }]);
	});
});

describe("claudeTurnItemsFromStream", () => {
	it("keeps earlier turns and replaces only this turn's live items", () => {
		expect(
			claudeTurnItemsFromStream({
				previousItems: [
					{
						kind: "userMessage",
						id: SessionItemId("old-user"),
						text: "first",
					},
					{
						kind: "agentMessage",
						id: SessionItemId("old-agent"),
						text: "done",
					},
					{
						kind: "userMessage",
						id: SessionItemId("new-user"),
						text: "now inspect",
					},
				],
				stream: `{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"looking"}]}}`,
			}),
		).toMatchObject([
			{ kind: "userMessage", text: "first" },
			{ kind: "agentMessage", text: "done" },
			{ kind: "userMessage", text: "now inspect" },
			{ kind: "reasoning", summaries: ["looking"] },
		]);
	});
});
