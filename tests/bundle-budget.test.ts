import { describe, expect, it } from "vitest";
import { checkBudget } from "../scripts/bundle-budget";

describe("bundle budget", () => {
	const budget = {
		budgetPercent: 5,
		baseline: { entryJs: 1000, firstLoadJs: 10_000, firstLoadCss: 2000 },
	};
	it("passes growth within the budget", () => {
		const results = checkBudget(budget, {
			entryJs: 1050,
			firstLoadJs: 9000,
			firstLoadCss: 2100,
		});
		expect(results.every((result) => !result.over)).toBe(true);
	});
	it("fails the metric that grew past it", () => {
		const results = checkBudget(budget, {
			entryJs: 1051,
			firstLoadJs: 10_000,
			firstLoadCss: 2000,
		});
		expect(results.filter((result) => result.over)).toEqual([
			{
				metric: "entryJs",
				baseline: 1000,
				current: 1051,
				limit: 1050,
				over: true,
			},
		]);
	});
});
