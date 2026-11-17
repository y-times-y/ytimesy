import { describe, expect, it } from "vitest";
import {
	formatUsdPerMillion,
	INCLUDED_IN_PLAN,
	modelContextLabel,
	modelPriceDisplay,
	nextFocusIndex,
	reasoningStepTarget,
} from "./model-picker-format";

const levels = [
	{ id: "low", label: "Low" },
	{ id: "medium", label: "Medium" },
	{ id: "high", label: "High" },
] as const;

describe("formatUsdPerMillion", () => {
	it("prints whole dollars bare and fractions with at least cents", () => {
		expect(formatUsdPerMillion(4)).toBe("$4");
		expect(formatUsdPerMillion(0.1)).toBe("$0.10");
		expect(formatUsdPerMillion(1.8)).toBe("$1.80");
		expect(formatUsdPerMillion(0.075)).toBe("$0.075");
	});
	it("prints nothing for a value that is not a price", () => {
		expect(formatUsdPerMillion(Number.NaN)).toBe("");
		expect(formatUsdPerMillion(-1)).toBe("");
	});
});

describe("modelPriceDisplay", () => {
	it("says the plan includes a plan model, whatever its list price", () => {
		expect(modelPriceDisplay("gpt-6-astra", true)).toEqual({ kind: "plan" });
		expect(INCLUDED_IN_PLAN).toBe("Included in plan");
	});
	it("shows the known list price as $in / $out", () => {
		const price = modelPriceDisplay("openai/gpt-6.2-sol", false);
		expect(price).toMatchObject({
			kind: "price",
			input: "$2",
			output: "$10",
			short: "$2 / $10",
		});
	});
	it("shows nothing for a model without a known price", () => {
		expect(modelPriceDisplay("vendor/not-priced-anywhere", false)).toBeNull();
	});
});

describe("modelContextLabel", () => {
	it("prefers the model's own listed window", () => {
		expect(modelContextLabel("anything", 272_000)).toBe("272K");
	});
	it("falls back to the checked-in limits, and to nothing", () => {
		expect(modelContextLabel("claude-opus-5-5")).toBe("1M");
		expect(modelContextLabel("vendor/unknown")).toBeNull();
	});
});

describe("reasoningStepTarget", () => {
	it("steps with the arrows and stops at the ends", () => {
		expect(reasoningStepTarget(levels, "low", "ArrowRight")).toBe("medium");
		expect(reasoningStepTarget(levels, "high", "ArrowLeft")).toBe("medium");
		expect(reasoningStepTarget(levels, "high", "ArrowRight")).toBeNull();
		expect(reasoningStepTarget(levels, "low", "ArrowLeft")).toBeNull();
	});
	it("jumps with Home and End and ignores other keys", () => {
		expect(reasoningStepTarget(levels, "medium", "Home")).toBe("low");
		expect(reasoningStepTarget(levels, "medium", "End")).toBe("high");
		expect(reasoningStepTarget(levels, "medium", "a")).toBeNull();
	});
});

describe("nextFocusIndex", () => {
	it("moves between options and stops at the ends", () => {
		expect(nextFocusIndex(0, 3, "ArrowDown")).toBe(1);
		expect(nextFocusIndex(2, 3, "ArrowDown")).toBe(2);
		expect(nextFocusIndex(2, 3, "ArrowUp")).toBe(1);
		expect(nextFocusIndex(1, 3, "End")).toBe(2);
		expect(nextFocusIndex(0, 0, "ArrowDown")).toBeNull();
	});
});
