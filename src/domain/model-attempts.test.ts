import { expect, it } from "vitest";
import {
	enableMultipleModelAttempts,
	expandModelAttempts,
	modelAttemptCountChoices,
	modelAttemptSummary,
	modelIdForAttempt,
	parallelAttemptModelIds,
	setModelAttemptCount,
	toggleModelAttempt,
} from "./model-attempts";

it("summarizes extra runs the way the composer names them", () => {
	expect(modelAttemptSummary("Grok 4.7 High Fast", 1)).toBe(
		"Grok 4.7 High Fast",
	);
	expect(modelAttemptSummary("Grok 4.7 High Fast", 2)).toBe(
		"Grok 4.7 High Fast + 1",
	);
	expect(modelAttemptSummary("Grok 4.7 High Fast", 3)).toBe(
		"Grok 4.7 High Fast + 2",
	);
	expect(modelAttemptSummary("", 2)).toBe("Select model");
});

it("checks models and repeats a checked model up to five agents", () => {
	const doubled = enableMultipleModelAttempts("alpha");
	expect(expandModelAttempts(doubled)).toEqual(["alpha", "alpha"]);
	const mixed = setModelAttemptCount(
		toggleModelAttempt(doubled, "beta"),
		"alpha",
		2,
	);
	expect(expandModelAttempts(mixed)).toEqual(["alpha", "alpha", "beta"]);
	expect(modelAttemptCountChoices(mixed, "beta")).toEqual([1, 2, 3]);
	expect(
		toggleModelAttempt(mixed, "gamma").map((slot) => slot.modelId),
	).toEqual(["alpha", "beta", "gamma"]);
	const full = setModelAttemptCount(mixed, "beta", 3);
	expect(expandModelAttempts(full)).toHaveLength(5);
	expect(toggleModelAttempt(full, "gamma")).toEqual(full);
	expect(modelIdForAttempt(["alpha", "alpha", "beta"], "fallback", 3)).toBe(
		"beta",
	);
	expect(modelIdForAttempt(null, "fallback", 1)).toBe("fallback");
});

it("keeps the first model aligned with the repeated run list", () => {
	expect(
		parallelAttemptModelIds({
			modelId: "alpha",
			leaderCount: 3,
			modelIds: ["alpha", "alpha", "beta"],
		}),
	).toEqual({ ok: true, modelIds: ["alpha", "alpha", "beta"] });
	expect(
		parallelAttemptModelIds({
			modelId: "alpha",
			leaderCount: 2,
		}).ok,
	).toBe(true);
	expect(
		parallelAttemptModelIds({
			modelId: "alpha",
			leaderCount: 2,
			modelIds: ["beta", "alpha"],
		}).ok,
	).toBe(false);
	expect(
		parallelAttemptModelIds({
			modelId: "alpha",
			leaderCount: 6,
		}).ok,
	).toBe(false);
});
