import { expect, it, vi } from "vitest";
import type { DynamicToolCallItem } from "#/domain/session-item";
import { createWholeItemReader, isCut } from "./whole-item";

vi.mock("./codex-session.fn", () => ({ getSessionItemDetail: vi.fn() }));

const call = (
	extra: object,
): DynamicToolCallItem & { detailSession?: string } => ({
	kind: "dynamicToolCall",
	id: "t1" as DynamicToolCallItem["id"],
	tool: "execute_command",
	status: "completed",
	...extra,
});

it("an item is cut only when a page marked it and named its chat", () => {
	expect(isCut(call({}))).toBe(false);
	expect(isCut(call({ truncated: true }))).toBe(false);
	expect(isCut(call({ truncated: true, detailSession: "s1" }))).toBe(true);
});

it("reads one item once however often its card opens, and again after a failure", async () => {
	const read = vi
		.fn()
		.mockRejectedValueOnce(new Error("offline"))
		.mockResolvedValue({ id: "t1", output: "whole" });
	const whole = createWholeItemReader(read);
	await expect(whole("s1", "t1")).rejects.toThrow("offline");
	const [a, b] = await Promise.all([whole("s1", "t1"), whole("s1", "t1")]);
	expect(a).toEqual({ id: "t1", output: "whole" });
	expect(b).toBe(a);
	await whole("s1", "t1");
	expect(read).toHaveBeenCalledTimes(2);
	// A running call's later state is another read.
	await whole("s1", "t1", "completed");
	expect(read).toHaveBeenCalledTimes(3);
});
