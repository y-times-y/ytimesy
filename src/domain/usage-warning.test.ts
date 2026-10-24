import { expect, it } from "vitest";
import { usageWindowState } from "./infrastructure-usage";
import { usageResetLabel, usageWarning } from "./usage-warning";

const now = Date.parse("2026-10-20T12:00:00Z");
const label = (ms: number) => new Date(ms).toISOString();
const windows = (fiveHourUsed: number, weeklyUsed = fiveHourUsed) => [
	usageWindowState(
		"five_hour",
		[{ at: now - 60_000, microUsd: fiveHourUsed, open: false }],
		1000,
		now,
	),
	usageWindowState(
		"weekly",
		[{ at: now - 60_000, microUsd: weeklyUsed, open: false }],
		5000,
		now,
	),
];

it("stays quiet below 80% of every window", () => {
	expect(usageWarning(windows(0), label)).toBeNull();
	expect(usageWarning(windows(799), label)).toBeNull();
});

it("gives a heads-up at 80% of a window with the time it starts to refill", () => {
	const warning = usageWarning(windows(850), label);
	expect(warning).toMatchObject({
		level: "warning",
		window: "five_hour",
		usedPercent: 85,
	});
	expect(warning?.message).toContain("85% of your 5-hour");
	expect(warning?.message).toContain(label(now - 60_000 + 5 * 3_600_000));
	expect(usageWarning(windows(100, 4500), label)?.window).toBe("weekly");
});

it("says when new work can start again once a window is exhausted", () => {
	const warning = usageWarning(windows(1000), label);
	expect(warning?.level).toBe("exhausted");
	expect(warning?.message).toContain("Running work finishes");
	expect(warning?.message).toContain(label(now - 60_000 + 5 * 3_600_000));
});

it("labels a reset with its date and how far away it is, in the given zone", () => {
	const zone = { locale: "en-US", timeZone: "America/Los_Angeles" };
	const friday = Date.parse("2026-10-23T10:15:00Z");
	expect(
		usageResetLabel(friday, Date.parse("2026-10-21T10:00:00Z"), zone),
	).toBe("Fri, Oct 23, 3:15 AM (in 2 days)");
	expect(
		usageResetLabel(friday, Date.parse("2026-10-23T05:00:00Z"), zone),
	).toBe("Fri, Oct 23, 3:15 AM (in 5 hours)");
	expect(
		usageResetLabel(friday, Date.parse("2026-10-23T10:00:00Z"), zone),
	).toBe("Fri, Oct 23, 3:15 AM (in 15 minutes)");
	expect(usageResetLabel(friday, friday + 60_000, zone)).toBe(
		"Fri, Oct 23, 3:15 AM",
	);
	expect(
		usageResetLabel(friday, Date.parse("2026-10-21T10:00:00Z"), {
			locale: "en-US",
			timeZone: "Asia/Tokyo",
		}),
	).toBe("Fri, Oct 23, 7:15 PM (in 2 days)");
});
