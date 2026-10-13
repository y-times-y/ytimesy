import { describe, expect, it } from "vitest";
import { sessionItemsFromOpenCodeMessages } from "./opencode-session-items";

describe("sessionItemsFromOpenCodeMessages", () => {
	it("streams reasoning and tool calls before the final assistant text", () => {
		expect(
			sessionItemsFromOpenCodeMessages([
				{
					info: { role: "user", id: "u1" },
					parts: [{ type: "text", text: "fix the composer" }],
				},
				{
					info: { role: "assistant", id: "a1" },
					parts: [
						{ type: "step-start" },
						{
							type: "reasoning",
							id: "r1",
							text: "I should inspect the timeline first.",
						},
						{
							type: "tool",
							id: "t1",
							tool: "read",
							callID: "call-read",
							state: {
								status: "running",
								input: { path: "src/features/sessions/session-timeline.tsx" },
							},
						},
					],
				},
			]),
		).toMatchObject([
			{ kind: "userMessage", text: "fix the composer" },
			{
				kind: "reasoning",
				summaries: ["I should inspect the timeline first."],
			},
			{
				kind: "dynamicToolCall",
				tool: "read session-timeline.tsx",
				status: "inProgress",
			},
		]);
	});

	it("shows bash as a live shell command instead of waiting for the reply", () => {
		expect(
			sessionItemsFromOpenCodeMessages([
				{
					info: { role: "assistant", id: "a1" },
					parts: [
						{
							type: "tool",
							tool: "bash",
							state: {
								status: "running",
								input: {
									command: "pnpm test",
									workdir: "/home/ubuntu/ytimesy",
								},
							},
						},
					],
				},
			]),
		).toMatchObject([
			{
				kind: "commandExecution",
				command: "pnpm test",
				cwd: "/home/ubuntu/ytimesy",
				status: "inProgress",
				output: null,
				exitCode: null,
			},
		]);
	});

	it("keeps completed reasoning duration and assistant text after the turn", () => {
		expect(
			sessionItemsFromOpenCodeMessages([
				{
					info: {
						role: "assistant",
						id: "a1",
						time: { created: 1_700_000_000_000, completed: 1_700_000_003_000 },
					},
					parts: [
						{ type: "reasoning", text: "checked the file" },
						{ type: "text", text: "Done." },
					],
				},
			]),
		).toMatchObject([
			{
				kind: "reasoning",
				summaries: ["checked the file"],
				durationSeconds: 3,
			},
			{ kind: "agentMessage", text: "Done." },
		]);
	});

	it("reads the older tool-invocation part shape", () => {
		expect(
			sessionItemsFromOpenCodeMessages({
				info: { role: "assistant", id: "a1" },
				parts: [
					{
						type: "tool-invocation",
						toolInvocation: {
							state: "call",
							toolName: "grep",
							args: { pattern: "session-working" },
						},
					},
				],
			}),
		).toMatchObject([
			{
				kind: "dynamicToolCall",
				tool: "grep session-working",
				status: "inProgress",
			},
		]);
	});
});
