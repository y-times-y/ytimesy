import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { boundedWait } from "./bounded";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("returns when the work finishes, without calling onTimeout", async () => {
	const onTimeout = vi.fn();
	await boundedWait(Promise.resolve(1), 1_000, onTimeout);
	expect(onTimeout).not.toHaveBeenCalled();
});

it("stops waiting for work that never finishes", async () => {
	const onTimeout = vi.fn();
	const waiting = boundedWait(new Promise(() => {}), 1_000, onTimeout);
	await vi.advanceTimersByTimeAsync(1_000);
	await waiting;
	expect(onTimeout).toHaveBeenCalledOnce();
});

it("treats a rejected task as finished", async () => {
	await expect(
		boundedWait(Promise.reject(new Error("x")), 1_000),
	).resolves.toBeUndefined();
});
