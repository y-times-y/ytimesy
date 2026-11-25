import { describe, expect, it } from "vitest";
import {
	cellFill,
	dayCell,
	dominantProvider,
	intensityLevel,
	levelThresholds,
	scaleMaximum,
	USAGE_PROVIDER_HUES,
	USAGE_PROVIDERS,
} from "./usage-heatmap";

describe("intensityLevel", () => {
	it("leaves empty days at 0 and gives any usage at least level 1", () => {
		expect(intensityLevel(0, 1000)).toBe(0);
		expect(intensityLevel(1, 1_000_000)).toBe(1);
		expect(intensityLevel(5, 0)).toBe(0);
	});
	it("steps up with tokens and tops out at the busiest day", () => {
		const levels = [100, 500, 2000, 5000, 10_000].map((t) =>
			intensityLevel(t, 10_000),
		);
		expect(levels).toEqual([1, 1, 2, 3, 4]);
		expect(intensityLevel(20_000, 10_000)).toBe(4);
	});
	it("agrees with the legend thresholds", () => {
		const [two, three, four] = levelThresholds(10_000);
		expect(intensityLevel(two - 1, 10_000)).toBe(1);
		expect(intensityLevel(two, 10_000)).toBe(2);
		expect(intensityLevel(three, 10_000)).toBe(3);
		expect(intensityLevel(four, 10_000)).toBe(4);
	});
});

describe("dayCell", () => {
	const day = { anthropic: 600, openai: 900, xai: 100 };
	it("All colours a day by its dominant provider and scales its total", () => {
		expect(dominantProvider(day)).toBe("openai");
		expect(dayCell(day, "all", 1600)).toEqual({
			tokens: 1600,
			level: 4,
			provider: "openai",
		});
	});
	it("a provider filter shows only that provider", () => {
		expect(dayCell(day, "anthropic", 600)).toEqual({
			tokens: 600,
			level: 4,
			provider: "anthropic",
		});
		expect(dayCell(day, "google", 600).provider).toBeNull();
	});
	it("breaks a tie toward the earlier provider", () => {
		expect(dominantProvider({ openai: 5, anthropic: 5 })).toBe("anthropic");
	});
	it("an absent day is empty", () => {
		expect(dayCell(undefined, "all", 100)).toEqual({
			tokens: 0,
			level: 0,
			provider: null,
		});
	});
});

describe("scaleMaximum", () => {
	it("is the busiest day under the filter", () => {
		const days = [{ anthropic: 5, openai: 20 }, { anthropic: 9 }];
		expect(scaleMaximum(days, "all")).toBe(25);
		expect(scaleMaximum(days, "anthropic")).toBe(9);
	});
});

describe("colours", () => {
	it("gives each provider its own hue", () => {
		const hues = USAGE_PROVIDERS.map((p) => USAGE_PROVIDER_HUES[p]);
		expect(new Set(hues).size).toBe(USAGE_PROVIDERS.length);
	});
	it("mixes the hue into the empty colour by level", () => {
		const fill = (level: 1 | 4) =>
			cellFill({ tokens: 1, level, provider: "google" });
		expect(fill(1)).toContain("28%");
		expect(fill(4)).toContain("100%");
		expect(cellFill({ tokens: 0, level: 0, provider: null })).toBe(
			"var(--usage-cell-empty)",
		);
	});
});
