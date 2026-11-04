import { expect, it } from "vitest";
import {
	alertHour,
	cronBlipNeedsAlert,
	cronBlipWindowMinutes,
	fleetBudgetAlerts,
} from "./owner-alerts";

it("emails a job's runtime blip only when its later runs blip too", () => {
	const now = new Date("2026-11-03T18:00:00Z");
	const blipped = (minutesAgo: number | null, everyMinutes: number) =>
		cronBlipNeedsAlert({
			episodeStartedAt:
				minutesAgo === null
					? null
					: new Date(now.getTime() - minutesAgo * 60_000),
			now,
			everyMinutes,
		});
	// The first blip, and others of the same deploy, are only logged.
	expect(blipped(null, 1)).toBe(false);
	expect(blipped(2, 1)).toBe(false);
	// Still failing a few runs later (an every-minute job), or on the next
	// run of a job that runs every 5 minutes or every 6 hours.
	expect(blipped(3, 1)).toBe(true);
	expect(blipped(5, 5)).toBe(true);
	expect(blipped(360, 360)).toBe(true);
	expect(cronBlipWindowMinutes(1)).toBe(5);
	expect(cronBlipWindowMinutes(5)).toBe(11);
	expect(cronBlipWindowMinutes(360)).toBe(721);
});

const usage = (monthly: number, lifetime: number) => ({
	period: "2026-10-01",
	monthlyUsedMicroUsd: monthly,
	monthlyCapMicroUsd: 100_000_000,
	lifetimeUsedMicroUsd: lifetime,
	lifetimeCapMicroUsd: 1_000_000_000,
});

it("stays quiet below 80% of either fleet budget", () => {
	expect(fleetBudgetAlerts(usage(79_000_000, 100_000_000))).toEqual([]);
});

it("alerts once per threshold: 80% and 95% of the month, and of the lifetime cap", () => {
	expect(
		fleetBudgetAlerts(usage(81_000_000, 0)).map((alert) => alert.key),
	).toEqual(["2026-10-01:monthly:80"]);
	expect(
		fleetBudgetAlerts(usage(96_000_000, 960_000_000)).map((alert) => alert.key),
	).toEqual(["2026-10-01:monthly:95", "lifetime:lifetime:95"]);
	const [alert] = fleetBudgetAlerts(usage(81_000_000, 0));
	expect(alert.subject).toBe("ytimesy: fleet monthly cloud budget at 81%");
	expect(alert.text).toContain("$81.00 of $100.00");
	expect(alert.text).toContain("YTIMESY_FLEET_MONTHLY_MICRO_USD");
});

it("ignores a cap that is not configured", () => {
	expect(
		fleetBudgetAlerts({
			...usage(5, 5),
			monthlyCapMicroUsd: 0,
			lifetimeCapMicroUsd: 0,
		}),
	).toEqual([]);
});

it("buckets alert keys by UTC hour", () => {
	expect(alertHour(new Date("2026-10-19T09:59:59Z"))).toBe("2026-10-19T09");
});
