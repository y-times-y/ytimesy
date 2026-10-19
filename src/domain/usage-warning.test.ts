import { expect, it } from "vitest";
import { usageWarning } from "./usage-warning";

const usage = (consumed: number, reserved = 0, allowance = 1000) => ({
	allowanceMicroUsd: allowance,
	consumedMicroUsd: consumed,
	reservedMicroUsd: reserved,
});

it("stays quiet below 70% of the monthly allowance", () => {
	expect(usageWarning(usage(0))).toBeNull();
	expect(usageWarning(usage(699))).toBeNull();
});

it("warns at 70%, counting minutes held by running machines", () => {
	expect(usageWarning(usage(700))).toMatchObject({
		level: "warning",
		usedPercent: 70,
	});
	expect(usageWarning(usage(500, 250))).toMatchObject({
		level: "warning",
		usedPercent: 75,
	});
	expect(usageWarning(usage(950))?.message).toContain("95%");
});

it("says the allowance is used up at 100% or with no allowance", () => {
	expect(usageWarning(usage(1000))?.level).toBe("exhausted");
	expect(usageWarning(usage(900, 200))?.level).toBe("exhausted");
	expect(usageWarning(usage(0, 0, 0))?.level).toBe("exhausted");
});
