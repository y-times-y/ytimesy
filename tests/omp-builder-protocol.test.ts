import { describe, expect, it } from "vitest";
import { ompBuilderProtocol } from "../benchmarks/evaluation/omp-builder-protocol";

describe("matched builder proof protocol", () => {
	it("reserves the worst-case request count for every arm", () => {
		for (const repetitions of [1, 3]) {
			const protocol = ompBuilderProtocol(repetitions);
			expect(protocol.requestLimit).toBe(
				protocol.arms.length * protocol.requestsPerArm,
			);
			expect(protocol.approval).toBe(`5-usd-${protocol.requestLimit}-requests`);
			expect(protocol.arms.length * protocol.armTimeoutMs).toBeLessThan(
				1500000,
			);
		}
	});

	it("alternates order while giving each pair exactly one arm per revision", () => {
		expect(ompBuilderProtocol(3).arms).toEqual([
			{ pair: 1, arm: "before" },
			{ pair: 1, arm: "after" },
			{ pair: 2, arm: "after" },
			{ pair: 2, arm: "before" },
			{ pair: 3, arm: "before" },
			{ pair: 3, arm: "after" },
		]);
	});

	it("rejects unsupported budgets before provisioning or inference", () => {
		for (const repetitions of [
			0,
			2,
			4,
			-1,
			Number.NaN,
			Number.POSITIVE_INFINITY,
		])
			expect(() => ompBuilderProtocol(repetitions)).toThrow();
	});
});
