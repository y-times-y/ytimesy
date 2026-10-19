import { expect, it } from "vitest";
import { alertHour, fleetBudgetAlerts } from "./owner-alerts";

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
