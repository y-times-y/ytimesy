import { expect, it } from "vitest";
import { harnessRegressionGate } from "./harness-regression-gate";

const sha = "a".repeat(64);
function fixture() {
	return {
		protocolSha256: sha,
		expectedTaskIds: ["task"],
		repetitions: 1,
		thresholds: {
			minimumIndependentTasks: 1,
			maximumPassRateLoss: 0,
			maximumLatencyRatio: 1,
			maximumCostRatio: 1,
		},
		comparabilityVerified: true,
		rows: (["ytimesy", "native-codex"] as const).map((arm) => ({
			taskId: "task",
			repetition: 0,
			arm,
			protocolSha256: sha,
			grade: { passed: true },
			executionAndExportMs: 100,
			reconciledCostUsd: 0.1,
			codeQualityReviewed: true,
		})),
	};
}
it("accepts complete reviewed and reconciled pairs at explicit thresholds", () => {
	expect(harnessRegressionGate(fixture()).status).toBe("passed");
});
it("does not turn missing arms, costs, review or comparability into a pass", () => {
	const input = fixture();
	input.rows.pop();
	input.rows[0].codeQualityReviewed = false;
	expect(harnessRegressionGate(input).status).toBe("inconclusive");
	expect(
		harnessRegressionGate({ ...fixture(), comparabilityVerified: false })
			.status,
	).toBe("inconclusive");
	expect(
		harnessRegressionGate({
			...fixture(),
			rows: fixture().rows.map((row) => ({ ...row, reconciledCostUsd: null })),
		}).status,
	).toBe("inconclusive");
});
it("includes failed runs and rejects slower or more expensive arms", () => {
	const input = fixture();
	input.rows[0].grade.passed = false;
	input.rows[0].executionAndExportMs = 200;
	input.rows[0].reconciledCostUsd = 0.2;
	expect(harnessRegressionGate(input)).toMatchObject({
		status: "failed",
		reasons: [
			"Correctness regression.",
			"Latency regression.",
			"Cost regression.",
		],
	});
});
it("rejects duplicate arms and too-small independent samples", () => {
	const input = fixture();
	input.rows.push(input.rows[0]);
	input.thresholds.minimumIndependentTasks = 10;
	expect(harnessRegressionGate(input).status).toBe("inconclusive");
});
