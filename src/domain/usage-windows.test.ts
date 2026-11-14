import { expect, it } from "vitest";
import { usageCapFailureMessage } from "./failure-message";
import {
	blockingUsageWindow,
	USAGE_WINDOW_REFUSAL_PATTERN,
	usageCeilingRefusal,
	usageWindowCeiling,
	usageWindowExpired,
	usageWindowRefusal,
	usageWindowState,
} from "./infrastructure-usage";

const hour = 3_600_000;
const now = Date.parse("2026-10-20T12:00:00Z");
const settled = (hoursAgo: number, microUsd: number) => ({
	at: now - hoursAgo * hour,
	microUsd,
	open: false,
});

it("counts usage from the window's start and resets it at a fixed time", () => {
	const startedAt = now - 4 * hour;
	const charges = [settled(6, 400), settled(4, 300), settled(1, 200)];
	expect(
		usageWindowState("five_hour", charges, 1000, startedAt, now),
	).toMatchObject({
		// The 6-hour-old charge belongs to the previous window.
		usedMicroUsd: 500,
		usedPercent: 50,
		exhausted: false,
		resetsAt: startedAt + 5 * hour,
	});
	expect(
		usageWindowState("weekly", charges, 1000, now - 24 * hour, now)
			.usedMicroUsd,
	).toBe(900);
	// Once the reset time passes, everything in it clears at once.
	expect(
		usageWindowState(
			"five_hour",
			charges,
			1000,
			startedAt,
			startedAt + 5 * hour,
		),
	).toMatchObject({ usedMicroUsd: 0, exhausted: false, resetsAt: null });
	expect(usageWindowState("five_hour", [], 1000, null, now)).toMatchObject({
		usedMicroUsd: 0,
		resetsAt: null,
	});
});

it("keeps an exhausted window's reset time where it was, as time passes and machines run", () => {
	const startedAt = now - 2 * hour;
	const charges = [
		settled(2, 600),
		settled(1, 300),
		{ at: now - 30 * 60_000, microUsd: 200, open: true },
	];
	const window = usageWindowState("five_hour", charges, 1000, startedAt, now);
	expect(window).toMatchObject({
		usedMicroUsd: 1100,
		usedPercent: 100,
		exhausted: true,
		resetsAt: now + 3 * hour,
	});
	for (const later of [1, 30, 90, 179].map((minutes) => minutes * 60_000))
		expect(
			usageWindowState("five_hour", charges, 1000, startedAt, now + later)
				.resetsAt,
		).toBe(now + 3 * hour);
	expect(
		usageWindowState("five_hour", charges, 1000, startedAt, now + 3 * hour)
			.exhausted,
	).toBe(false);
});

it("counts running machines' holds in the current window, whatever their age", () => {
	const hold = { at: now - 30 * hour, microUsd: 700, open: true };
	expect(
		usageWindowState("five_hour", [hold], 1000, now - hour, now),
	).toMatchObject({ usedMicroUsd: 700, resetsAt: now + 4 * hour });
	// No window running: it still counts, and the next usage starts one.
	expect(usageWindowState("five_hour", [hold], 1000, null, now)).toMatchObject({
		usedMicroUsd: 700,
		resetsAt: null,
	});
});

it("starts a new window only once the last one has reset", () => {
	expect(usageWindowExpired("five_hour", null, now)).toBe(true);
	expect(usageWindowExpired("five_hour", now - 5 * hour + 1, now)).toBe(false);
	expect(usageWindowExpired("five_hour", now - 5 * hour, now)).toBe(true);
	expect(usageWindowExpired("weekly", now - 5 * hour, now)).toBe(false);
});

it("picks the window that reopens last and words its refusal with the time", () => {
	const fiveHour = usageWindowState(
		"five_hour",
		[settled(1, 1000)],
		1000,
		now - hour,
		now,
	);
	const weekly = usageWindowState(
		"weekly",
		[settled(1, 1000)],
		1000,
		now - hour,
		now,
	);
	expect(blockingUsageWindow([fiveHour, weekly])?.id).toBe("weekly");
	expect(
		blockingUsageWindow([
			fiveHour,
			usageWindowState("weekly", [], 1000, null, now),
		])?.id,
	).toBe("five_hour");
	expect(blockingUsageWindow([])).toBeNull();
	const refusal = usageWindowRefusal(fiveHour);
	expect(refusal).toContain("until 2026-10-20 16:00 UTC");
	expect(USAGE_WINDOW_REFUSAL_PATTERN.test(`Error: ${refusal}`)).toBe(true);
});

it("treats a zero limit as exhausted and refuses invalid amounts", () => {
	expect(usageWindowState("five_hour", [], 0, null, now).exhausted).toBe(true);
	expect(() => usageWindowState("five_hour", [], -1, null, now)).toThrow();
});

it("puts the hard ceiling an hour of the machine past the limit and words its refusal", () => {
	expect(usageWindowCeiling(1000, 132_240)).toBe(133_240);
	expect(usageWindowCeiling(1000, 0)).toBe(1000);
	const fiveHour = usageWindowState(
		"five_hour",
		[settled(1, 1000)],
		1000,
		now - hour,
		now,
	);
	const refusal = usageCeilingRefusal(fiveHour);
	expect(refusal).toContain("until 2026-10-20 16:00 UTC");
	expect(usageCapFailureMessage(`Error: ${refusal}`)).toBe(refusal);
});

it("starts a window an auto-reset began empty, counting only what running holds add after it", () => {
	const resetAt = now - hour;
	const before = settled(3, 900);
	// A machine running at the reset: it held 400 then and 650 now.
	const running = { at: now - 2 * hour, microUsd: 650, open: true };
	const after = settled(0.5, 100);
	const state = (charges: Parameters<typeof usageWindowState>[1]) =>
		usageWindowState("five_hour", charges, 1000, resetAt, now, 400);
	expect(state([before]).usedMicroUsd).toBe(0);
	expect(state([before, running]).usedMicroUsd).toBe(250);
	expect(state([before, running, after])).toMatchObject({
		usedMicroUsd: 350,
		resetsAt: resetAt + 5 * hour,
		exhausted: false,
	});
	// It settled after the reset below what it held then: no credit is taken
	// from new usage, and nothing goes negative.
	const refunded = { ...running, open: false, microUsd: 300, settledAt: now };
	expect(state([before, refunded, after]).usedMicroUsd).toBe(100);
	// Without a carried amount the window counts the ordinary way.
	expect(
		usageWindowState("five_hour", [before, running], 1000, resetAt, now)
			.usedMicroUsd,
	).toBe(650);
	// Once the reset window itself ends, it counts like any expired window.
	expect(
		usageWindowState(
			"five_hour",
			[running],
			1000,
			resetAt,
			resetAt + 5 * hour,
			400,
		).usedMicroUsd,
	).toBe(650);
});
