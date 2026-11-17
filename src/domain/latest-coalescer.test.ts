import { describe, expect, it } from "vitest";
import { LatestCoalescer } from "./latest-coalescer";

function harness() {
	let clock = 0;
	const timers: { at: number; run: () => void }[] = [];
	const sent: number[][] = [];
	const coalescer = new LatestCoalescer<number[]>(
		(value) => {
			sent.push(value);
		},
		{
			everyMs: 500,
			now: () => clock,
			setTimer: (run, ms) => {
				const timer = { at: clock + ms, run };
				timers.push(timer);
				return timer;
			},
			clearTimer: (timer) => {
				const index = timers.indexOf(timer as never);
				if (index >= 0) timers.splice(index, 1);
			},
		},
	);
	const advance = async (ms: number) => {
		clock += ms;
		for (const timer of timers.filter((t) => t.at <= clock)) {
			timers.splice(timers.indexOf(timer), 1);
			timer.run();
		}
		await Promise.resolve();
		await Promise.resolve();
	};
	return { coalescer, sent, advance };
}

describe("LatestCoalescer", () => {
	it("sends the first value at once and at most one batch per window, newest wins", async () => {
		const { coalescer, sent, advance } = harness();
		coalescer.push([1]);
		await advance(0);
		expect(sent).toEqual([[1]]);
		for (let i = 2; i <= 40; i++) {
			coalescer.push([i]);
			await advance(10);
		}
		expect(sent).toEqual([[1]]);
		await advance(500);
		expect(sent).toEqual([[1], [40]]);
	});

	it("40 updates over 2 seconds produce at most 5 messages", async () => {
		const { coalescer, sent, advance } = harness();
		for (let i = 0; i < 40; i++) {
			coalescer.push([i]);
			await advance(50);
		}
		await advance(500);
		expect(sent.length).toBeLessThanOrEqual(5);
		expect(sent.at(-1)).toEqual([39]);
	});

	it("flush sends what is pending now; discard and close drop it", async () => {
		const { coalescer, sent, advance } = harness();
		coalescer.push([1]);
		await advance(0);
		coalescer.push([2]);
		await coalescer.flush();
		expect(sent).toEqual([[1], [2]]);
		coalescer.push([3]);
		coalescer.discard();
		await advance(1_000);
		expect(sent).toEqual([[1], [2]]);
		coalescer.push([4]);
		await advance(0);
		coalescer.push([5]);
		coalescer.close();
		await advance(1_000);
		coalescer.push([6]);
		await advance(1_000);
		expect(sent).toEqual([[1], [2], [4]]);
	});
});
