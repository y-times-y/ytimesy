import { expect, it } from "vitest";
import { usageCapFailureMessage } from "./failure-message";
import {
	blockingUsageWindow,
	USAGE_WINDOW_REFUSAL_PATTERN,
	usageCeilingRefusal,
	usageWindowCeiling,
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

it("counts only settlements inside the rolling window", () => {
	const charges = [settled(6, 400), settled(4, 300), settled(1, 200)];
	expect(usageWindowState("five_hour", charges, 1000, now)).toMatchObject({
		usedMicroUsd: 500,
		usedPercent: 50,
		exhausted: false,
		// The oldest counted charge (4 hours ago) leaves in 1 hour.
		resetsAt: now + hour,
	});
	expect(usageWindowState("weekly", charges, 1000, now).usedMicroUsd).toBe(900);
	expect(
		usageWindowState("weekly", [settled(24 * 7 + 1, 900)], 1000, now),
	).toMatchObject({ usedMicroUsd: 0, resetsAt: null });
});

it("counts running machines' holds now, whatever their age", () => {
	const window = usageWindowState(
		"five_hour",
		[{ at: now - 30 * hour, microUsd: 700, open: true }],
		1000,
		now,
	);
	expect(window.usedMicroUsd).toBe(700);
	expect(window.resetsAt).toBe(now + 5 * hour);
});

it("reopens an exhausted window when enough old usage has left it", () => {
	const charges = [settled(4, 300), settled(3, 500), settled(1, 400)];
	const window = usageWindowState("five_hour", charges, 1000, now);
	expect(window).toMatchObject({
		usedMicroUsd: 1200,
		usedPercent: 100,
		exhausted: true,
	});
	// Dropping the 4-hour-old charge leaves 900 < 1000: reopens at its expiry.
	expect(window.resetsAt).toBe(now - 4 * hour + 5 * hour);
	const deeper = usageWindowState("five_hour", charges, 500, now);
	// 1200 -> 900 -> 400: the 3-hour-old charge must leave too.
	expect(deeper.resetsAt).toBe(now - 3 * hour + 5 * hour);
});

it("picks the window that reopens last and words its refusal with the time", () => {
	const fiveHour = usageWindowState("five_hour", [settled(1, 1000)], 1000, now);
	const weekly = usageWindowState("weekly", [settled(1, 1000)], 1000, now);
	expect(blockingUsageWindow([fiveHour, weekly])?.id).toBe("weekly");
	expect(
		blockingUsageWindow([fiveHour, usageWindowState("weekly", [], 1000, now)])
			?.id,
	).toBe("five_hour");
	expect(blockingUsageWindow([])).toBeNull();
	const refusal = usageWindowRefusal(fiveHour);
	expect(refusal).toContain("until 2026-10-20 16:00 UTC");
	expect(USAGE_WINDOW_REFUSAL_PATTERN.test(`Error: ${refusal}`)).toBe(true);
});

it("treats a zero limit as exhausted and refuses invalid amounts", () => {
	expect(usageWindowState("five_hour", [], 0, now).exhausted).toBe(true);
	expect(() => usageWindowState("five_hour", [], -1, now)).toThrow();
});

it("puts the hard ceiling an hour of the machine past the limit and words its refusal", () => {
	expect(usageWindowCeiling(1000, 132_240)).toBe(133_240);
	expect(usageWindowCeiling(1000, 0)).toBe(1000);
	const fiveHour = usageWindowState("five_hour", [settled(1, 1000)], 1000, now);
	const refusal = usageCeilingRefusal(fiveHour);
	expect(refusal).toContain("until 2026-10-20 16:00 UTC");
	expect(usageCapFailureMessage(`Error: ${refusal}`)).toBe(refusal);
});
