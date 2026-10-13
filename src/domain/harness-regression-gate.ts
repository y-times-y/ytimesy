import { z } from "zod";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const regressionGateInput = z.object({
	protocolSha256: sha256,
	expectedTaskIds: z.array(z.string().min(1)).min(1),
	repetitions: z.number().int().positive(),
	thresholds: z.object({
		minimumIndependentTasks: z.number().int().positive(),
		maximumPassRateLoss: z.number().min(0).max(1),
		maximumLatencyRatio: z.number().positive(),
		maximumCostRatio: z.number().positive(),
	}),
	comparabilityVerified: z.boolean(),
	rows: z.array(
		z.object({
			taskId: z.string(),
			repetition: z.number().int().nonnegative(),
			arm: z.enum(["ytimesy", "native-codex"]),
			protocolSha256: sha256,
			grade: z.object({ passed: z.boolean() }),
			executionAndExportMs: z.number().nonnegative().finite(),
			reconciledCostUsd: z.number().nonnegative().finite().nullable(),
			codeQualityReviewed: z.boolean(),
		}),
	),
});

/** A complete development regression gate, not a statistical market-superiority claim. */
export function harnessRegressionGate(raw: unknown) {
	const input = regressionGateInput.parse(raw);
	const reasons: string[] = [];
	const tasks = new Set(input.expectedTaskIds);
	if (tasks.size !== input.expectedTaskIds.length)
		reasons.push("Duplicate expected tasks.");
	const rows = new Map<string, (typeof input.rows)[number]>();
	for (const row of input.rows) {
		const key = `${row.taskId}:${row.repetition}:${row.arm}`;
		if (
			rows.has(key) ||
			!tasks.has(row.taskId) ||
			row.repetition >= input.repetitions
		)
			reasons.push("Duplicate or unexpected evaluation arm.");
		if (row.protocolSha256 !== input.protocolSha256)
			reasons.push("Frozen protocol mismatch.");
		rows.set(key, row);
	}
	for (const task of tasks) {
		for (let repetition = 0; repetition < input.repetitions; repetition++) {
			for (const arm of ["ytimesy", "native-codex"] as const) {
				if (!rows.has(`${task}:${repetition}:${arm}`))
					reasons.push(
						"Missing paired arm; failed runs must remain in the denominator.",
					);
			}
		}
	}
	if (tasks.size < input.thresholds.minimumIndependentTasks)
		reasons.push(
			"Insufficient independent tasks; repetitions do not increase the sample size.",
		);
	if (!input.comparabilityVerified)
		reasons.push(
			"Resource, model, reasoning and limit comparability are not verified.",
		);
	if (input.rows.some((row) => row.reconciledCostUsd === null))
		reasons.push("Costs are not fully reconciled.");
	if (input.rows.some((row) => !row.codeQualityReviewed))
		reasons.push("Independent code-quality review is incomplete.");
	if (reasons.length)
		return {
			status: "inconclusive" as const,
			reasons: [...new Set(reasons)],
			metrics: null,
		};
	const arms = ["ytimesy", "native-codex"] as const;
	const totals = arms.map((arm) => {
		const selected = input.rows.filter((row) => row.arm === arm);
		return {
			passRate:
				selected.filter((row) => row.grade.passed).length / selected.length,
			latency: selected.reduce((sum, row) => sum + row.executionAndExportMs, 0),
			cost: selected.reduce(
				(sum, row) => sum + (row.reconciledCostUsd ?? 0),
				0,
			),
		};
	});
	const ratio = (value: number, baseline: number) =>
		baseline === 0 ? (value === 0 ? 1 : Infinity) : value / baseline;
	const metrics = {
		passRateDifference: totals[0].passRate - totals[1].passRate,
		latencyRatio: ratio(totals[0].latency, totals[1].latency),
		costRatio: ratio(totals[0].cost, totals[1].cost),
	};
	if (metrics.passRateDifference < -input.thresholds.maximumPassRateLoss)
		reasons.push("Correctness regression.");
	if (metrics.latencyRatio > input.thresholds.maximumLatencyRatio)
		reasons.push("Latency regression.");
	if (metrics.costRatio > input.thresholds.maximumCostRatio)
		reasons.push("Cost regression.");
	return {
		status: reasons.length ? ("failed" as const) : ("passed" as const),
		reasons,
		metrics,
	};
}
