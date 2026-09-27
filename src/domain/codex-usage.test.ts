import { expect, it } from "vitest";
import { parseCodexUsage } from "./codex-usage";

it("preserves unknown usage instead of inventing zero", () => {
	expect(parseCodexUsage(undefined)).toBeUndefined();
	expect(parseCodexUsage({ limits: null, context: null })).toEqual({
		limits: null,
		context: null,
	});
});
it("uses the last context size rather than lifetime token totals", () => {
	expect(
		parseCodexUsage({
			context: {
				last: { totalTokens: 1200 },
				total: { totalTokens: 900000 },
				modelContextWindow: 128000,
			},
		})?.context,
	).toEqual({ last: { totalTokens: 1200 }, modelContextWindow: 128000 });
});
it("validates percentages and strips unrelated provider fields", () => {
	expect(
		parseCodexUsage({
			limits: { rateLimits: { primary: { usedPercent: -1 } } },
		}),
	).toBeUndefined();
	expect(
		parseCodexUsage({
			secret: "not public",
			limits: {
				rateLimits: {
					primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 123 },
				},
			},
		}),
	).not.toHaveProperty("secret");
});
