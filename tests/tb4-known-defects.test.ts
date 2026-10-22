import { describe, expect, it } from "vitest";
import {
	KNOWN_DATASET_DEFECTS,
	preflightVerdict,
} from "../scripts/tb4-known-defects.ts";

describe("tb4 known dataset defects", () => {
	it("lists cad-model with its evidence", () => {
		const cad = KNOWN_DATASET_DEFECTS.find((d) => d.task === "cad-model");
		expect(cad?.evidence).toContain("OCP.collections");
	});

	it("reports the recorded failure as a dataset defect", () => {
		expect(
			preflightVerdict("cad-model", {
				passed: false,
				reason: "oracle scored 0 (needs 1)",
			}),
		).toBe("dataset-defect");
	});

	it("stays strict for any other failure, other tasks and missing records", () => {
		expect(
			preflightVerdict("cad-model", {
				passed: false,
				reason: "oracle scored 0 (needs 1); nop scored 1 (needs 0)",
			}),
		).toBe("failed");
		expect(
			preflightVerdict("cad-model", {
				passed: false,
				reason: "oracle raised VerifierTimeoutError",
			}),
		).toBe("failed");
		expect(
			preflightVerdict("vpp-loss-divergence", {
				passed: false,
				reason: "oracle scored 0 (needs 1)",
			}),
		).toBe("failed");
		expect(preflightVerdict("cad-model", undefined)).toBe("missing");
		expect(preflightVerdict("cad-model", { passed: true, reason: null })).toBe(
			"passed",
		);
	});
});
