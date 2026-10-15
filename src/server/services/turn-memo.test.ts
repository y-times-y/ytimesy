import { beforeEach, expect, it, vi } from "vitest";
import { clearTurnMemo, forgetTurnMemo, turnMemo } from "./turn-memo";

beforeEach(() => clearTurnMemo());

it("loads once per key and forgets a finished turn", async () => {
	const load = vi.fn(async () => "value");
	expect(await turnMemo("turn:a", load)).toBe("value");
	expect(await turnMemo("turn:a", load)).toBe("value");
	expect(load).toHaveBeenCalledOnce();
	forgetTurnMemo("other");
	await turnMemo("turn:a", load);
	expect(load).toHaveBeenCalledOnce();
	forgetTurnMemo("turn");
	await turnMemo("turn:a", load);
	expect(load).toHaveBeenCalledTimes(2);
});

it("never keeps failures or values the caller declines", async () => {
	const failing = vi.fn(async () => {
		throw new Error("unavailable");
	});
	await expect(turnMemo("turn:fail", failing)).rejects.toThrow("unavailable");
	await expect(turnMemo("turn:fail", failing)).rejects.toThrow("unavailable");
	expect(failing).toHaveBeenCalledTimes(2);
	const unpinned = vi.fn(async () => null);
	await turnMemo("turn:base", unpinned, (value) => value !== null);
	await turnMemo("turn:base", unpinned, (value) => value !== null);
	expect(unpinned).toHaveBeenCalledTimes(2);
});
