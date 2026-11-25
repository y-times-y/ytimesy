import { expect, it } from "vitest";
import { syntheticUsage } from "./synthetic-usage";

it("is reproducible and covers the year with unique rows", () => {
	const a = syntheticUsage("2026-11-25");
	expect(syntheticUsage("2026-11-25")).toEqual(a);
	expect((a[0]?.day ?? "") >= "2025-11-26").toBe(true);
	expect((a.at(-1)?.day ?? "z") <= "2026-11-25").toBe(true);
	expect(new Set(a.map((r) => r.day)).size).toBeGreaterThan(200);
	const keys = a.map((r) =>
		[r.day, r.provider, r.modelId, r.source, r.project].join(),
	);
	expect(new Set(keys).size).toBe(keys.length);
});
it("never makes unknown turns exceed turns or negative counts", () => {
	for (const r of syntheticUsage("2026-11-25")) {
		expect(r.unknownTurns).toBeLessThanOrEqual(r.turns);
		expect(
			Math.min(r.inputTokens, r.outputTokens, r.cacheReadTokens),
		).toBeGreaterThanOrEqual(0);
		expect(r.cacheReadTokens).toBeLessThanOrEqual(r.inputTokens);
	}
});
