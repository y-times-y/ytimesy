import type { ModelMessage } from "ai";
import { expect, it, vi } from "vitest";
import { compactApiHistory } from "./api-agent-context";

it("keeps short conversations unchanged without a summarization call", async () => {
	const messages: ModelMessage[] = [{ role: "user", content: "Fix the test" }];
	const summarize = vi.fn();
	expect(await compactApiHistory(messages, summarize)).toEqual({
		messages,
		compacted: false,
	});
	expect(summarize).not.toHaveBeenCalled();
});

it("summarizes only older turns while retaining recent user requests", async () => {
	const messages: ModelMessage[] = [
		{ role: "user", content: `Original request ${"a".repeat(36_000)}` },
		{ role: "assistant", content: "Implemented first part" },
		{ role: "user", content: `Second request ${"b".repeat(36_000)}` },
		{ role: "assistant", content: "Investigating" },
		{ role: "user", content: `Current request ${"c".repeat(36_000)}` },
	];
	const summarize = vi.fn(async () => "The first part was implemented.");
	const result = await compactApiHistory(messages, summarize);
	expect(result.compacted).toBe(true);
	expect(summarize).toHaveBeenCalledWith(messages.slice(0, 2));
	expect(result.messages[0]).toMatchObject({ role: "assistant" });
	expect(result.messages.slice(1)).toEqual(messages.slice(2));
});

it("fails instead of silently dropping an oversized current task", async () => {
	const messages: ModelMessage[] = [
		{ role: "user", content: "Earlier" },
		{ role: "user", content: "x".repeat(100_000) },
	];
	await expect(compactApiHistory(messages, vi.fn())).rejects.toThrow(
		"Recent task activity exceeds",
	);
});
