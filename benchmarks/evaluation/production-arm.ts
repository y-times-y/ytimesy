import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
	EvaluationProtocol,
	EvaluationTask,
} from "#/domain/harness-evaluation";
import type { WorkspaceMachines } from "#/server/services/workspace-machines";
import { redactEvaluationText } from "./artifacts";
import {
	closeProductionEvaluation,
	exportReviewedEvaluationPatches,
	openProductionEvaluation,
	productionEvaluationEvidence,
	productionEvaluationSnapshot,
	submitProductionEvaluation,
} from "./production";

/** Harbor calls this same production bridge; it does not instantiate a second agent loop. */
export async function runProductionArm(input: {
	machines: WorkspaceMachines;
	userId: string;
	task: EvaluationTask;
	protocol: EvaluationProtocol;
	outputPath: string;
	signal?: AbortSignal;
}) {
	if (process.env.YTIMESY_EVALUATION_APPROVED !== "codex-subscription")
		throw new Error("Subscription evaluation approval is required.");
	const { machines, userId, task, protocol } = input;
	input.signal?.throwIfAborted();
	const attempt = await openProductionEvaluation(
		machines,
		userId,
		task,
		protocol,
	);
	try {
		await mkdir(input.outputPath, { recursive: true, mode: 0o700 });
		input.signal?.throwIfAborted();
		await writeFile(
			join(input.outputPath, "active-attempt.json"),
			JSON.stringify(attempt),
			{ mode: 0o600 },
		);
		await submitProductionEvaluation(machines, userId, attempt, task, protocol);
		const deadline = Date.now() + protocol.limits.durationSeconds * 1000;
		let state = await productionEvaluationSnapshot(userId, attempt.rootId);
		while (!state.settled && Date.now() < deadline) {
			input.signal?.throwIfAborted();
			await new Promise((done) => setTimeout(done, 1000));
			state = await productionEvaluationSnapshot(userId, attempt.rootId);
		}
		const patches = await exportReviewedEvaluationPatches(
			machines,
			userId,
			attempt.rootId,
			task.commit,
		);
		const evidence = await productionEvaluationEvidence(userId, attempt.rootId);
		await writeFile(
			join(input.outputPath, "evidence.json"),
			redactEvaluationText(JSON.stringify(evidence, null, 2)),
			{ mode: 0o600 },
		);
		for (const [index, artifact] of patches.entries())
			await writeFile(
				join(input.outputPath, `${index}.patch`),
				artifact.patch,
				{ mode: 0o600 },
			);
		await writeFile(
			join(input.outputPath, "result.json"),
			JSON.stringify({
				rootId: attempt.rootId,
				runId: attempt.runId,
				patchFiles: patches.map((_, index) => `${index}.patch`),
				completed: true,
			}),
			{ mode: 0o600 },
		);
	} finally {
		await closeProductionEvaluation(machines, userId, attempt);
	}
}
