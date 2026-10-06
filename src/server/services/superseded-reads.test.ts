import type { ModelMessage } from "ai";
import { expect, it, vi } from "vitest";
import { archiveSupersededReads } from "./superseded-reads";

const read = (
	id: string,
	value: unknown,
	toolName = "read_file",
): ModelMessage => ({
	role: "tool",
	content: [
		{
			type: "tool-result",
			toolCallId: id,
			toolName,
			output: { type: "json", value: value as never },
		},
	],
});

it("archives exact prior bodies without deleting result identity or the latest read", async () => {
	const older = read("old", {
		path: "src/main.ts",
		start: 0,
		content: "x".repeat(5000),
		nextStart: null,
	});
	const latest = read("new", {
		path: "src/main.ts",
		start: 0,
		content: "short updated file",
		nextStart: null,
	});
	const history = [older, latest];
	const archive = vi.fn(async () => "archive:fixture");
	const projected = await archiveSupersededReads(history, archive);
	expect(archive).toHaveBeenCalledExactlyOnceWith(history);
	expect(projected[1]).toBe(latest);
	expect(JSON.stringify(projected[0])).toContain('"toolCallId":"old"');
	expect(JSON.stringify(projected[0])).toContain(
		'"reference":"archive:fixture"',
	);
	expect(JSON.stringify(projected[0])).not.toContain("x".repeat(100));
	expect(JSON.stringify(older)).toContain("x".repeat(100));
});

it("never substitutes a partial read, failed output, or failed archive for full evidence", async () => {
	const older = read("old", {
		path: "src/main.ts",
		start: 0,
		content: "x".repeat(5000),
		nextStart: null,
	});
	const partial = read("partial", {
		path: "src/main.ts",
		start: 0,
		content: "new",
		nextStart: 3,
	});
	const archive = vi.fn(async () => "archive:fixture");
	const partialHistory = [older, partial];
	expect(await archiveSupersededReads(partialHistory, archive)).toBe(
		partialHistory,
	);
	expect(archive).not.toHaveBeenCalled();
	const complete = read("complete", {
		path: "src/main.ts",
		start: 0,
		content: "new",
		nextStart: null,
	});
	const history = [older, complete];
	expect(
		await archiveSupersededReads(history, async () => {
			throw new Error("archive unavailable");
		}),
	).toBe(history);
	expect(await archiveSupersededReads(history)).toBe(history);
});

it("retires only superseded entries in a batch and remains idempotent", async () => {
	const history = [
		read(
			"batch",
			[
				{ path: "a.ts", content: "a".repeat(5000), truncated: false },
				{ path: "b.ts", content: "b".repeat(5000), truncated: false },
			],
			"read_files",
		),
		read("new", { path: "a.ts", content: "new", start: 0, nextStart: null }),
	];
	const projected = await archiveSupersededReads(
		history,
		async () => "archive:fixture",
	);
	expect(JSON.stringify(projected[0])).toContain("b".repeat(5000));
	expect(JSON.stringify(projected[0])).not.toContain("a".repeat(100));
	const archive = vi.fn(async () => "archive:other");
	expect(await archiveSupersededReads(projected, archive)).toBe(projected);
	expect(archive).not.toHaveBeenCalled();
});
