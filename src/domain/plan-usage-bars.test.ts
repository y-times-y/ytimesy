import { describe, expect, it } from "vitest";
import { SubscriptionUsageLimitReached } from "./api-turn-failure";
import type { CodexUsage } from "./codex-usage";
import { SessionItemId } from "./ids";
import { subscriptionLimitResetsAt } from "./model-failover-reason";
import {
	planLimitSwitches,
	planUsageBars,
	UNKNOWN_RESET_HOLD_MS,
	withPlanLimitReached,
} from "./plan-usage-bars";
import type { SessionItem } from "./session-item";

const NOW = Date.UTC(2026, 9, 26, 12);
const HOUR = 60 * 60_000;
const seconds = (ms: number) => ms / 1000;

function usage(fiveHourPercent: number, weeklyPercent: number): CodexUsage {
	return {
		limits: {
			rateLimitsByLimitId: {
				codex: {
					limitId: "codex",
					// The weekly window first: bars still read shortest first.
					secondary: {
						usedPercent: weeklyPercent,
						windowDurationMins: 7 * 24 * 60,
						resetsAt: seconds(NOW + 72 * HOUR),
					},
					primary: {
						usedPercent: fiveHourPercent,
						windowDurationMins: 300,
						resetsAt: seconds(NOW + 2 * HOUR),
					},
				},
				other_feature: {
					primary: { usedPercent: 99, windowDurationMins: 60 },
				},
			},
		},
	};
}

describe("plan usage bars", () => {
	it("maps the Codex bucket's windows, shortest first, with resets in ms", () => {
		expect(planUsageBars(usage(42.4, 10))).toEqual([
			{ id: "primary", label: "5h", usedPercent: 42, resetsAt: NOW + 2 * HOUR },
			{
				id: "secondary",
				label: "Week",
				usedPercent: 10,
				resetsAt: NOW + 72 * HOUR,
			},
		]);
	});

	it("has no bars when the plan's usage could not be read", () => {
		expect(planUsageBars(null)).toEqual([]);
		expect(planUsageBars(undefined)).toEqual([]);
		expect(planUsageBars({ limits: { rateLimitsByLimitId: {} } })).toEqual([]);
	});

	it("fills the window whose reset matches the limit's, with its reset time", () => {
		const reset = NOW + 2 * HOUR + 60_000;
		const bars = withPlanLimitReached(
			planUsageBars(usage(70, 30)),
			{ resetsAt: reset, at: NOW },
			NOW,
		);
		expect(
			bars.map((bar) => [bar.label, bar.usedPercent, bar.resetsAt]),
		).toEqual([
			["5h", 100, reset],
			["Week", 30, NOW + 72 * HOUR],
		]);
	});

	it("fills the weekly window for a limit resetting days away", () => {
		const bars = withPlanLimitReached(
			planUsageBars(usage(20, 60)),
			{ resetsAt: NOW + 40 * HOUR, at: NOW },
			NOW,
		);
		expect(bars.map((bar) => bar.usedPercent)).toEqual([20, 100]);
	});

	it("fills the fullest window when the limit gave no reset time, for an hour", () => {
		const bars = planUsageBars(usage(20, 97));
		const limit = { resetsAt: null, at: NOW };
		expect(
			withPlanLimitReached(bars, limit, NOW).map((bar) => bar.usedPercent),
		).toEqual([20, 100]);
		expect(
			withPlanLimitReached(bars, limit, NOW + UNKNOWN_RESET_HOLD_MS).map(
				(bar) => bar.usedPercent,
			),
		).toEqual([20, 97]);
	});

	it("drops the mark once the limit has reset", () => {
		const bars = planUsageBars(usage(5, 30));
		expect(
			withPlanLimitReached(bars, { resetsAt: NOW - 1, at: NOW - HOUR }, NOW),
		).toEqual(bars);
	});

	it("shows one full bar when a limit was hit but usage is unread", () => {
		expect(
			withPlanLimitReached([], { resetsAt: NOW + HOUR, at: NOW }, NOW),
		).toEqual([
			{ id: "limit", label: "5h", usedPercent: 100, resetsAt: NOW + HOUR },
		]);
		expect(withPlanLimitReached([], null, NOW)).toEqual([]);
	});
});

describe("plan limit switches", () => {
	it("lists usage-limit failovers only, with their reset", () => {
		const base = {
			kind: "modelSwitch" as const,
			message: "",
			from: { model: "GPT-6.1 Sol", connection: "Codex" },
			to: { model: "GPT-6.1 Sol", connection: "OpenRouter", key: "k" },
			state: "switched" as const,
		};
		const items: SessionItem[] = [
			{ ...base, id: SessionItemId("a"), reason: "outage" },
			{
				...base,
				id: SessionItemId("b"),
				reason: "usage-limit",
				resetsAt: NOW + HOUR,
			},
			{ ...base, id: SessionItemId("c"), reason: "usage-limit" },
		];
		expect(planLimitSwitches(items)).toEqual([
			{ id: "b", resetsAt: NOW + HOUR },
			{ id: "c", resetsAt: null },
		]);
	});

	it("reads the reset from a wrapped usage-limit failure", () => {
		const spent = new SubscriptionUsageLimitReached(new Date(NOW + HOUR));
		expect(subscriptionLimitResetsAt(new Error("x", { cause: spent }))).toBe(
			NOW + HOUR,
		);
		expect(
			subscriptionLimitResetsAt(new SubscriptionUsageLimitReached(null)),
		).toBeUndefined();
		expect(subscriptionLimitResetsAt(new Error("other"))).toBeUndefined();
	});
});
