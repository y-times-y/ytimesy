import { expect, it, vi } from "vitest";
import {
	modelRequestBody,
	modelRequestRecorder,
} from "./model-request-recorder";

const tools = [
	{
		type: "function",
		name: "bash",
		description: "Runs a command.",
		inputSchema: { type: "object" },
	},
	{ type: "provider", name: "web_search", id: "openai.web_search", args: {} },
];

it("stores each distinct prompt and tool list once, under a stable hash", () => {
	const first = modelRequestBody({ instructions: "Be brief.", tools });
	expect(modelRequestBody({ instructions: "Be brief.", tools }).hash).toBe(
		first.hash,
	);
	expect(modelRequestBody({ instructions: "Be long.", tools }).hash).not.toBe(
		first.hash,
	);
	expect(first.body.tools).toEqual([
		{
			name: "bash",
			type: "function",
			description: "Runs a command.",
			inputSchema: { type: "object" },
		},
		{ name: "web_search", type: "provider", id: "openai.web_search" },
	]);
});

it("numbers a step's requests and never fails the turn on a write error", async () => {
	const save = vi
		.fn()
		.mockRejectedValueOnce(new Error("db down"))
		.mockResolvedValue(undefined);
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	const recorder = modelRequestRecorder({
		sessionId: "session",
		turnId: "turn",
		step: 3,
		save,
	});
	recorder.record({ instructions: "A", tools });
	recorder.record({ instructions: "A", tools: undefined });
	await recorder.flush();
	expect(
		save.mock.calls.map(([, record]) => [record.step, record.call]),
	).toEqual([
		[3, 0],
		[3, 1],
	]);
	expect(save.mock.calls[0][1].tools).toEqual(["bash", "web_search"]);
	expect(save.mock.calls[1][1].tools).toEqual([]);
	expect(warn).toHaveBeenCalledOnce();
	warn.mockRestore();
});
