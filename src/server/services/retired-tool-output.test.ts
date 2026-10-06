import type { ModelMessage } from "ai";
import { expect, it, vi } from "vitest";
import { archiveEarlierToolOutput } from "./retired-tool-output";

const reference = "37ba9eb0-031e-4b82-9296-e4ce22f9ee7e";
const body = "historical output ".repeat(400);
const capture = {
	reference,
	exitCode: 125,
	stopped: "output_limit",
	stdout: body,
	stderr: "failure",
	stdoutNextStart: 32000,
	stderrNextStart: null,
};
function result(value: unknown, toolName = "bash"): ModelMessage {
	return {
		role: "tool",
		content: [
			{
				type: "tool-result",
				toolName,
				toolCallId: "command",
				output: { type: "json", value: value as never },
			},
		],
	};
}
function history(value: unknown, toolName = "bash"): ModelMessage[] {
	return [
		{ role: "user", content: "Earlier request" },
		{
			role: "assistant",
			content: [
				{ type: "tool-call", toolName, toolCallId: "command", input: {} },
			],
		},
		result(value, toolName),
		{ role: "assistant", content: "Observed the output" },
		{ role: "user", content: "Continue" },
	];
}
function output(messages: ModelMessage[]) {
	const message = messages[2];
	if (message.role !== "tool") throw new Error("Expected result");
	const part = message.content[0];
	if (part.type !== "tool-result" || part.output.type !== "json")
		throw new Error("Expected JSON");
	return part.output.value;
}

it("retires historical command bodies but preserves failure, stop and paging evidence", async () => {
	const messages = history(capture);
	const archive = vi.fn(async () => "archive:fixture");
	const projected = await archiveEarlierToolOutput(messages, archive);
	expect(archive).toHaveBeenCalledExactlyOnceWith(messages);
	expect(output(projected)).toMatchObject({
		reference,
		exitCode: 125,
		stopped: "output_limit",
		stdoutNextStart: 32000,
		stderr: "failure",
		archivedOutput: {
			reference: "archive:fixture",
			messageIndex: 2,
			toolCallId: "command",
			characters: { stdout: body.length },
		},
	});
	expect(JSON.stringify(projected).length).toBeLessThan(
		JSON.stringify(messages).length,
	);
	expect(JSON.stringify(projected)).not.toContain(body);
	expect(output(messages)).toBe(capture);
	expect(projected[1]).toBe(messages[1]);
	const secondArchive = vi.fn(async () => "archive:second");
	expect(await archiveEarlierToolOutput(projected, secondArchive)).toBe(
		projected,
	);
	expect(secondArchive).not.toHaveBeenCalled();
});

it("retains current-turn outputs, small results, unknown tools and missing archive", async () => {
	const messages = history(capture).slice(0, -1);
	const archive = vi.fn(async () => "archive:fixture");
	expect(await archiveEarlierToolOutput(messages, archive)).toBe(messages);
	for (const [value, name] of [
		[{ ...capture, stdout: "small" }, "bash"],
		[capture, "unknown"],
		[{ ...capture, reference: "not-an-artifact" }, "bash"],
	] as const) {
		const untouched = history(value, name);
		expect(await archiveEarlierToolOutput(untouched, archive)).toBe(untouched);
	}
	expect(archive).not.toHaveBeenCalled();
	const earlier = history(capture);
	expect(await archiveEarlierToolOutput(earlier)).toBe(earlier);
});

it("does not treat steering input before consumption as a completed prior turn", async () => {
	const messages = history(capture);
	messages.splice(3, 1);
	const archive = vi.fn(async () => "archive:fixture");
	expect(await archiveEarlierToolOutput(messages, archive)).toBe(messages);
	expect(archive).not.toHaveBeenCalled();
});

it("leaves exact history intact when archival fails or returns no reference", async () => {
	for (const archive of [
		async () => {
			throw new Error("storage unavailable");
		},
		async () => "",
	]) {
		const messages = history(capture);
		expect(await archiveEarlierToolOutput(messages, archive)).toBe(messages);
		expect(output(messages)).toBe(capture);
	}
});

it("preserves all check metadata and archives one exact snapshot for a batch", async () => {
	const verification = {
		sourcesStable: false,
		before: { hash: "before" },
		after: { hash: "after" },
	};
	const small = { ...capture, stdout: "small" };
	const messages = history(
		[{ ...capture, passed: false, command: "pnpm test", verification }, small],
		"run_checks",
	);
	const archive = vi.fn(async () => "archive:checks");
	const projected = await archiveEarlierToolOutput(messages, archive);
	expect(archive).toHaveBeenCalledOnce();
	expect(output(projected)).toMatchObject([
		{
			passed: false,
			command: "pnpm test",
			verification,
			archivedOutput: { reference: "archive:checks" },
		},
		small,
	]);
	expect((output(projected) as unknown[])[1]).toStrictEqual(small);
});

it("retains page recovery, completion and Unicode-safe previews", async () => {
	const unicode = "\u{1f680}".repeat(5000);
	const messages = history(
		{
			reference,
			stream: "stderr",
			content: unicode,
			start: 32000,
			nextStart: 64000,
			completion: { status: 1, stopped: null },
		},
		"read_tool_output",
	);
	const projected = await archiveEarlierToolOutput(
		messages,
		async () => "archive:page",
	);
	expect(output(projected)).toMatchObject({
		stream: "stderr",
		start: 32000,
		nextStart: 64000,
		completion: { status: 1, stopped: null },
		archivedOutput: { characters: { content: 5000 } },
	});
	expect(JSON.stringify(output(projected))).not.toMatch(
		/\\ud[89ab][0-9a-f]{2}/i,
	);
});
