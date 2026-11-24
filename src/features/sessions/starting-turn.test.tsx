import { runInNewContext } from "node:vm";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import {
	remainingStartWait,
	StartingTurn,
	scheduleStartingTurnWait,
} from "./starting-turn";

afterEach(() => vi.useRealTimers());

it("counts from the turn start, including across a reload", () => {
	vi.useFakeTimers();
	vi.setSystemTime(100_000);
	const startedAt = Date.now();
	vi.advanceTimersByTime(7_000);
	expect(remainingStartWait(startedAt, Date.now())).toBe(13_000);
	vi.advanceTimersByTime(12_999);
	expect(remainingStartWait(startedAt, Date.now())).toBe(1);
	vi.advanceTimersByTime(1);
	expect(remainingStartWait(startedAt, Date.now())).toBe(0);
	vi.advanceTimersByTime(60_000);
	expect(remainingStartWait(startedAt, Date.now())).toBe(0);
	expect(remainingStartWait(undefined, Date.now())).toBeUndefined();
});

it("times an untimed turn from mount and resets when the timestamp changes", () => {
	vi.useFakeTimers();
	vi.setSystemTime(50_000);
	const update = vi.fn();
	const cancel = scheduleStartingTurnWait(undefined, Date.now(), update);
	expect(update).toHaveBeenLastCalledWith(false);
	vi.advanceTimersByTime(19_999);
	expect(update).toHaveBeenCalledTimes(1);
	vi.advanceTimersByTime(1);
	expect(update).toHaveBeenLastCalledWith(true);
	cancel?.();
	const cancelNew = scheduleStartingTurnWait(65_000, Date.now(), update);
	expect(update).toHaveBeenLastCalledWith(false);
	vi.advanceTimersByTime(14_999);
	expect(update).toHaveBeenLastCalledWith(false);
	vi.advanceTimersByTime(1);
	expect(update).toHaveBeenLastCalledWith(true);
	cancelNew?.();
	scheduleStartingTurnWait(1_000, Date.now(), update);
	expect(update).toHaveBeenLastCalledWith(true);
});

it("corrects the server markup before paint on reload, but not for a new or untimed turn", () => {
	function firstPaint(startedAt: number | undefined, now: number) {
		const html = renderToStaticMarkup(<StartingTurn startedAt={startedAt} />);
		const id = html.match(/<p id="([^"]+)"/)?.[1];
		const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
		expect(id).toBeDefined();
		if (!script) throw new Error("Missing first-paint script");
		const element = {
			textContent: "Starting…",
			className: "session-working session-shimmer",
		};
		runInNewContext(script, {
			document: {
				getElementById: (requested: string) =>
					requested === id ? element : null,
			},
			Date: { now: () => now },
		});
		return element;
	}
	expect(firstPaint(5_000, 24_999).textContent).toBe("Starting…");
	expect(firstPaint(5_000, 25_000)).toEqual({
		textContent: "Still waiting for the first response or step…",
		className: "session-working",
	});
	expect(firstPaint(undefined, 500_000).textContent).toBe("Starting…");
});
