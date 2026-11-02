import { expect, it } from "vitest";
import { SessionItemId } from "./ids";
import type { SessionItem } from "./session-item";
import {
	chatTrainingParts,
	sessionItemTrainingParts,
	trainingExportParts,
} from "./training-data";

const id = SessionItemId;

const chat: SessionItem[] = [
	{
		kind: "userMessage",
		id: id("u1"),
		text: "Fix the failing date test",
		attachments: [
			{ id: "a1", name: "log.txt", mediaType: "text/plain", size: 10 },
		],
	},
	{
		kind: "reasoning",
		id: id("r1"),
		summaries: ["The parser drops the timezone"],
	},
	{
		kind: "commandExecution",
		id: id("c1"),
		command: "pnpm test date",
		cwd: null,
		status: "completed",
		output: "1 failed: expected UTC",
		exitCode: 1,
	},
	{
		kind: "dynamicToolCall",
		id: id("d1"),
		tool: "read_file",
		input: '{"path":"README.md"}',
		output: "# Project readme",
		status: "completed",
	},
	{
		kind: "fileChange",
		id: id("f1"),
		status: "completed",
		changes: [
			{
				path: "src/date.ts",
				change: "update",
				additions: 2,
				deletions: 1,
				preview: "+ return parse(value, { zone: 'UTC' })",
			},
		],
	},
	{
		kind: "dynamicToolCall",
		id: id("d2"),
		tool: "read_file",
		input: '{"path":"src/date.ts"}',
		output: "export function parse() { /* model code */ }",
		status: "completed",
	},
	{
		kind: "dynamicToolCall",
		id: id("d3"),
		tool: "create_task",
		input: '{"brief":"check other parsers"}',
		output: "Helper report: all parsers fixed",
		status: "completed",
	},
	{
		kind: "agentMessage",
		id: id("m1"),
		text: "Fixed: the parser now keeps UTC.",
	},
];

it("keeps the user's words and the environment's answers, never model output", () => {
	const kept = trainingExportParts(chat, [
		{ id: "pr", outcome: { kind: "pullRequest", state: "merged" } },
		{ id: "fb", outcome: { kind: "userFeedback", rating: "up" } },
	]);
	expect(kept.every((part) => part.source !== "model")).toBe(true);
	const contents = kept.map((part) => part.content);
	expect(contents).toContain("Fix the failing date test");
	expect(contents).toContain("1 failed: expected UTC");
	expect(contents).toContain("1");
	expect(contents).toContain("# Project readme");
	expect(contents).toContain("merged");
	expect(contents).toContain("up");
	for (const modelText of [
		"The parser drops the timezone",
		"pnpm test date",
		"+ return parse(value, { zone: 'UTC' })",
		"Fixed: the parser now keeps UTC.",
		"Helper report: all parsers fixed",
		"export function parse() { /* model code */ }",
	])
		expect(contents).not.toContain(modelText);
});

it("marks generated diffs as model output but where they landed as the environment's", () => {
	const parts = sessionItemTrainingParts(chat[4]);
	expect(parts.map((part) => [part.field, part.source])).toEqual([
		["changes", "environment"],
		["changes.0.preview", "model"],
	]);
	expect(parts[0].content).not.toContain("zone");
});

it("treats reading back a file the model wrote as model output", () => {
	const parts = chatTrainingParts(chat).filter((part) => part.itemId === "d2");
	expect(parts.find((part) => part.field === "output")?.source).toBe("model");
});

it("treats any tool not known to answer from the environment as model output", () => {
	const parts = sessionItemTrainingParts(chat[6]);
	expect(parts.find((part) => part.field === "output")?.source).toBe("model");
});

it("classifies attachments as the user's but leaves them out of the export", () => {
	const parts = sessionItemTrainingParts(chat[0]);
	expect(parts.map((part) => part.source)).toEqual(["user", "user"]);
	expect(trainingExportParts([chat[0]]).map((part) => part.field)).toEqual([
		"text",
	]);
});

it("drops a local agent's handoff transcript, which holds model replies", () => {
	const handoff: SessionItem = {
		kind: "handoff",
		id: id("h1"),
		tool: "claude",
		title: "Earlier work",
		turns: 3,
		at: "2026-11-01T00:00:00.000Z",
		context: "assistant: here is the code",
	};
	expect(trainingExportParts([handoff])).toEqual([]);
});
