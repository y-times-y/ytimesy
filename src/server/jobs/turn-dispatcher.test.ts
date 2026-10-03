import { expect, it, vi } from "vitest";
import { TurnDispatcher } from "./turn-dispatcher";

it("fills capacity immediately and drains admitted turns without claiming more", async () => {
	const pending = [1, 2, 3];
	const finish = new Map<number, () => void>();
	const started: number[] = [];
	const claim = vi.fn(async () => pending.shift() ?? null);
	const dispatcher = new TurnDispatcher({
		concurrency: 2,
		claim,
		run: (turn: number) =>
			new Promise<void>((resolve) => {
				started.push(turn);
				finish.set(turn, resolve);
			}),
		onError: vi.fn(),
	});
	dispatcher.wake();
	await vi.waitFor(() => expect(started).toEqual([1, 2]));
	finish.get(1)?.();
	await vi.waitFor(() => expect(started).toEqual([1, 2, 3]));
	pending.push(4);
	let drained = false;
	const drain = dispatcher.drain().then(() => {
		drained = true;
	});
	dispatcher.wake();
	finish.get(2)?.();
	await Promise.resolve();
	expect(drained).toBe(false);
	finish.get(3)?.();
	await drain;
	expect(started).toEqual([1, 2, 3]);
	expect(pending).toEqual([4]);
});

it("retains a turn whose claim resolves during shutdown", async () => {
	let admit: (value: number | null) => void = () => {};
	let complete: () => void = () => {};
	const run = vi.fn(
		() =>
			new Promise<void>((resolve) => {
				complete = resolve;
			}),
	);
	const dispatcher = new TurnDispatcher({
		concurrency: 1,
		claim: () =>
			new Promise<number | null>((resolve) => {
				admit = resolve;
			}),
		run,
		onError: vi.fn(),
	});
	dispatcher.wake();
	const drain = dispatcher.drain();
	admit(1);
	await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
	complete();
	await drain;
});
