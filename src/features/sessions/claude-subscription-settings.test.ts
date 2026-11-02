import { describe, expect, it } from "vitest";
import { claudeSubscriptionMeta } from "./claude-subscription-settings";

const view = {
	enabled: true as const,
	limitedUntil: null,
	models: [],
};

describe("Claude subscription card", () => {
	it("says one short line per state, with the detail in a tooltip", () => {
		expect(
			claudeSubscriptionMeta({ ...view, status: "disconnected" }).tooltip,
		).toMatch(/claude setup-token/);
		expect(claudeSubscriptionMeta({ ...view, status: "refused" }).text).toBe(
			"Token refused",
		);
		expect(
			claudeSubscriptionMeta(
				{ ...view, status: "limited", limitedUntil: 90 * 60_000 },
				0,
			).text,
		).toBe("Usage used up · resets in 1 h");
		for (const status of [
			"disconnected",
			"connected",
			"refused",
			"limited",
		] as const)
			expect(
				claudeSubscriptionMeta({ ...view, status }).text.length,
			).toBeLessThan(40);
	});
});
