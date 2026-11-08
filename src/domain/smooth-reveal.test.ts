import { describe, expect, it } from "vitest";
import {
	REVEAL_CATCH_UP_MS,
	REVEAL_MAX_CADENCE_MS,
	REVEAL_MAX_LAG_MS,
	revealedLength,
	type TextArrival,
} from "./smooth-reveal";

/** Reveals `text` frame by frame (16 ms) until it shows in full; the ms that took. */
function revealTime(text: string, arrivals: TextArrival[], from = 0) {
	let shown = from;
	let now = 0;
	while (shown < text.length && now < 10_000) {
		now += 16;
		shown = revealedLength({ text, shown, arrivals, now, elapsed: 16 });
	}
	return now;
}

describe("revealedLength", () => {
	it("shows everything once the backlog is gone", () => {
		expect(
			revealedLength({
				text: "done",
				shown: 4,
				arrivals: [],
				now: 0,
				elapsed: 16,
			}),
		).toBe(4);
	});

	it("reveals a small backlog gradually, at word ends", () => {
		const text = "The quick brown fox jumps over the lazy dog. ".repeat(4);
		const next = revealedLength({
			text,
			shown: 0,
			arrivals: [{ end: text.length, at: 0 }],
			now: 16,
			elapsed: 16,
		});
		expect(next).toBeGreaterThan(0);
		expect(next).toBeLessThan(text.length / 4);
		expect(text[next]).toBe(" ");
	});

	it("catches up faster when the backlog grows", () => {
		const step = (backlog: number) =>
			revealedLength({
				text: "x".repeat(backlog),
				shown: 0,
				arrivals: [{ end: backlog, at: 0 }],
				now: 16,
				elapsed: 16,
			});
		expect(step(4_000)).toBeGreaterThan(step(400) * 5);
	});

	it("never lags more than the limit behind an arrival", () => {
		const text = "word ".repeat(2_000);
		expect(revealTime(text, [{ end: text.length, at: 0 }])).toBeLessThanOrEqual(
			REVEAL_MAX_LAG_MS + 16,
		);
	});

	it("drains a typical burst in about the catch-up time", () => {
		const text = "word ".repeat(12);
		const time = revealTime(text, [{ end: text.length, at: 0 }]);
		expect(time).toBeGreaterThan(REVEAL_CATCH_UP_MS / 2);
		expect(time).toBeLessThan(REVEAL_MAX_LAG_MS);
	});

	it("spreads a burst over the snapshot cadence so slow snapshots still flow", () => {
		const text = "word ".repeat(40);
		const arrivals = [{ end: text.length, at: 0 }];
		const fast = revealTime(text, arrivals);
		const slow = revealedTimeWithCadence(text, arrivals, 1_200);
		expect(slow).toBeGreaterThan(fast * 1.5);
		expect(slow).toBeLessThanOrEqual(1_200 + 500 + 16);
	});

	it("still shows everything within the lag limit at any cadence", () => {
		const text = "word ".repeat(2_000);
		expect(
			revealedTimeWithCadence(text, [{ end: text.length, at: 0 }], 5_000),
		).toBeLessThanOrEqual(REVEAL_MAX_CADENCE_MS + 500 + 16);
	});
});

function revealedTimeWithCadence(
	text: string,
	arrivals: TextArrival[],
	cadence: number,
) {
	let shown = 0;
	let now = 0;
	while (shown < text.length && now < 10_000) {
		now += 16;
		shown = revealedLength({
			text,
			shown,
			arrivals,
			now,
			elapsed: 16,
			cadence,
		});
	}
	return now;
}
