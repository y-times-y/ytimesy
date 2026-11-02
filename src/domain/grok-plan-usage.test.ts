import { describe, expect, it } from "vitest";
import {
	grokPlanUsageBars,
	grokPlanUsageFromBilling,
	grokPlanUsageFromJson,
} from "./grok-plan-usage";

// The shape xAI's Grok CLI billing endpoint returned on 2026-11-02.
const billing = {
	config: {
		currentPeriod: {
			type: "USAGE_PERIOD_TYPE_WEEKLY",
			start: "2026-10-27T17:39:52.407040+00:00",
			end: "2026-11-03T17:39:52.407040+00:00",
		},
		creditUsagePercent: 10,
		onDemandCap: { val: 0 },
		onDemandUsed: { val: 0 },
		productUsage: [
			{ product: "GrokChat", usagePercent: 8 },
			{ product: "GrokImagine", usagePercent: 2 },
			{ product: "GrokBuild" },
		],
		isUnifiedBillingUser: true,
		prepaidBalance: { val: 0 },
		billingPeriodStart: "2026-10-27T17:39:52.407040+00:00",
		billingPeriodEnd: "2026-11-03T17:39:52.407040+00:00",
	},
};
const resetsAt = Date.parse("2026-11-03T17:39:52.407Z");

describe("Grok plan usage", () => {
	it("reads the weekly window and its reset from the billing body", () => {
		expect(grokPlanUsageFromBilling(billing, 1)).toEqual({
			windows: [{ id: "weekly", usedPercent: 10, resetsAt }],
			readAt: 1,
		});
	});

	it("falls back to the flat period end, clamps, and names an unknown period Plan", () => {
		const usage = grokPlanUsageFromBilling(
			{
				config: {
					creditUsagePercent: 140.4,
					billingPeriodEnd: "2026-11-03T17:39:52.407040+00:00",
				},
			},
			1,
		);
		expect(usage?.windows).toEqual([
			{ id: "plan", usedPercent: 100, resetsAt },
		]);
		expect(grokPlanUsageBars(usage, 0)[0]?.label).toBe("Plan");
	});

	it("reads nothing from a body without a usage percent", () => {
		for (const body of [
			null,
			"x",
			[],
			{},
			{ config: [] },
			{ config: { creditUsagePercent: "10" } },
			{ config: { monthlyLimit: { val: 1 }, used: { val: 0 } } },
		])
			expect(grokPlanUsageFromBilling(body, 1)).toBeNull();
	});

	it("shows Week, and starts a window over once its reset passed", () => {
		const usage = grokPlanUsageFromBilling(billing, 1);
		expect(grokPlanUsageBars(usage, resetsAt - 1)).toEqual([
			{ id: "weekly", label: "Week", usedPercent: 10, resetsAt },
		]);
		expect(grokPlanUsageBars(usage, resetsAt)).toEqual([
			{ id: "weekly", label: "Week", usedPercent: 0, resetsAt: null },
		]);
		expect(grokPlanUsageBars(null, 0)).toEqual([]);
	});

	it("checks a stored reading", () => {
		const usage = grokPlanUsageFromBilling(billing, 1);
		expect(grokPlanUsageFromJson(JSON.parse(JSON.stringify(usage)))).toEqual(
			usage,
		);
		expect(grokPlanUsageFromJson(null)).toBeNull();
		expect(grokPlanUsageFromJson({ windows: [] })).toBeNull();
		expect(
			grokPlanUsageFromJson({
				readAt: 1,
				windows: [
					{ id: "weekly", usedPercent: 101 },
					{ id: 3, usedPercent: 1 },
					{ id: "weekly", usedPercent: 5, resetsAt: "soon" },
				],
			}),
		).toEqual({
			readAt: 1,
			windows: [{ id: "weekly", usedPercent: 5, resetsAt: null }],
		});
	});
});
