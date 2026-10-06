import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
	evaluationProtocolSchema,
	pairedEvaluationSchedule,
} from "#/domain/harness-evaluation";
import { AuthSnapshotId } from "#/domain/ids";
import {
	codexSubscriptionCatalog,
	readCodexSubscriptionUsage,
} from "#/server/adapters/codex-subscription";
import { closeDatabase, database } from "#/server/adapters/database";
import { createFreestyleWorkspaceMachines } from "#/server/adapters/freestyle/workspace-machines";
import { closeJobQueueForTests } from "#/server/jobs/queue";
import { redactEvaluationText } from "./artifacts";
import { gradeEvaluationPatches, preflightEvaluationGrader } from "./grader";
import { runNativeCodexEvaluation } from "./native-codex";
import {
	closeProductionEvaluation,
	exportReviewedEvaluationPatches,
	openProductionEvaluation,
	productionEvaluationEvidence,
	productionEvaluationSnapshot,
	submitProductionEvaluation,
} from "./production";
import { readEvaluationSnapshot } from "./read-snapshot";

/** No inference on import. Operator inputs stay outside the public application and coding workspaces. */
export async function runPairedEvaluation(input: {
	protocolPath: string;
	repositoryPath: string;
	outputPath: string;
	userId: string;
	/** Rerun only the selected implementation against an already-recorded control. */
	arms?: readonly ("ytimesy" | "native-codex")[];
	signal?: AbortSignal;
}) {
	input.signal?.throwIfAborted();
	if (process.env.YTIMESY_EVALUATION_APPROVED !== "codex-subscription")
		throw new Error(
			"Explicit subscription pilot approval is required; API fallback is unavailable.",
		);
	const bytes = await readFile(input.protocolPath, "utf8");
	const protocol = evaluationProtocolSchema.parse(JSON.parse(bytes));
	if (protocol.phase !== "development")
		throw new Error(
			"Final holdout execution requires separately agreed protocol and sample approval.",
		);
	const key = process.env.FREESTYLE_API_KEY;
	if (!key) throw new Error("Freestyle is not configured.");
	const catalog = await codexSubscriptionCatalog(input.userId);
	const model = catalog.find((row) => row.id === protocol.modelId);
	if (
		!model?.reasoning?.levels.some((level) => level.id === protocol.reasoning)
	)
		throw new Error(
			"Requested model/reasoning is not in the connected catalog.",
		);
	await preflightEvaluationGrader({
		repositoryPath: input.repositoryPath,
		tasks: protocol.tasks,
		image: protocol.graderImage,
	});
	const directory = resolve(input.outputPath, randomUUID());
	await mkdir(directory, { recursive: true, mode: 0o700 });
	await writeFile(join(directory, "protocol.json"), bytes, { mode: 0o600 });
	const machines = createFreestyleWorkspaceMachines(key);
	const beforeQuota = await readCodexSubscriptionUsage(input.userId);
	const results: unknown[] = [];
	try {
		for (const pair of pairedEvaluationSchedule(protocol)) {
			input.signal?.throwIfAborted();
			const preparationStarted = Date.now();
			// One clean prepared checkout yields both environments; coding starts only afterward.
			const attempt = await openProductionEvaluation(
				machines,
				input.userId,
				pair.task,
				protocol,
			);
			let snapshotId: string | undefined;
			try {
				await writeFile(
					join(directory, "active-attempt.json"),
					JSON.stringify(attempt),
					{ mode: 0o600 },
				);
				snapshotId = await machines.snapshotEnvironment(
					attempt.vmId as Parameters<typeof machines.snapshotEnvironment>[0],
					`ytimesy-eval-${randomUUID().slice(0, 8)}`,
				);
				const sharedPreparationMs = Date.now() - preparationStarted;
				for (const arm of pair.arms.filter(
					(arm) => !input.arms || input.arms.includes(arm),
				)) {
					input.signal?.throwIfAborted();
					const started = Date.now();
					let patches: string[] = [];
					let evidence: unknown;
					let completed = false;
					let failureStage: "infrastructure" | "harness" = "infrastructure";
					try {
						if (arm === "native-codex") {
							const native = await runNativeCodexEvaluation({
								machines,
								userId: input.userId,
								snapshotId,
								task: pair.task,
								protocol,
								signal: input.signal,
							});
							patches = native.patches;
							evidence = { ...native, patches: undefined };
							completed = native.exitCode === 0;
						} else {
							// Deadline begins on submission, not while the other arm is running.
							await database().query(
								"update harness_evaluation_run set deadline=now()+$2*interval '1 second' where id=$1 and state='active'",
								[attempt.runId, protocol.limits.durationSeconds],
							);
							await submitProductionEvaluation(
								machines,
								input.userId,
								attempt,
								pair.task,
								protocol,
							);
							const deadline =
								Date.now() + protocol.limits.durationSeconds * 1000;
							let observed = await readEvaluationSnapshot(() =>
								productionEvaluationSnapshot(input.userId, attempt.rootId),
							);
							while (!observed.settled && Date.now() < deadline) {
								input.signal?.throwIfAborted();
								await new Promise((done) => setTimeout(done, 1000));
								observed = await readEvaluationSnapshot(() =>
									productionEvaluationSnapshot(input.userId, attempt.rootId),
								);
								await writeFile(
									join(directory, "active-attempt.json"),
									JSON.stringify({
										rootId: attempt.rootId,
										runId: attempt.runId,
										taskId: pair.task.id,
										arm,
									}),
									{ mode: 0o600 },
								);
							}
							evidence = await readEvaluationSnapshot(() =>
								productionEvaluationEvidence(input.userId, attempt.rootId),
							);
							failureStage = "harness";
							patches = (
								await exportReviewedEvaluationPatches(
									machines,
									input.userId,
									attempt.rootId,
									pair.task.commit,
								)
							).map((row) => row.patch);
							completed = true;
						}
						failureStage = "infrastructure";
						const gradingStarted = Date.now();
						const grade = completed
							? await gradeEvaluationPatches({
									task: pair.task,
									patches,
									repositoryPath: input.repositoryPath,
									image: protocol.graderImage,
									timeoutMs: 120000,
								})
							: {
									passed: false,
									failure: "harness",
									detail: "Arm did not complete.",
								};
						const result = {
							taskId: pair.task.id,
							benchmark: pair.task.benchmark,
							repetition: pair.repetition,
							arm,
							durationMs: Date.now() - started,
							sharedPreparationMs,
							executionAndExportMs: gradingStarted - started,
							gradingMs: Date.now() - gradingStarted,
							grade,
							evidence,
							protocolSha256: createHash("sha256").update(bytes).digest("hex"),
						};
						results.push(result);
						await writeFile(
							join(directory, `${pair.task.id}-${pair.repetition}-${arm}.json`),
							redactEvaluationText(JSON.stringify(result, null, 2)),
							{ mode: 0o600 },
						);
						await writeFile(
							join(
								directory,
								`${pair.task.id}-${pair.repetition}-${arm}.patch`,
							),
							patches.join("\n"),
							{ mode: 0o600 },
						);
					} catch (error) {
						const result = {
							taskId: pair.task.id,
							benchmark: pair.task.benchmark,
							repetition: pair.repetition,
							arm,
							durationMs: Date.now() - started,
							grade: {
								passed: false,
								failure: failureStage,
								detail:
									error instanceof Error ? error.message : "Unknown failure",
							},
							evidence,
							protocolSha256: createHash("sha256").update(bytes).digest("hex"),
						};
						results.push(result);
						await writeFile(
							join(directory, `${pair.task.id}-${pair.repetition}-${arm}.json`),
							redactEvaluationText(JSON.stringify(result, null, 2)),
							{ mode: 0o600 },
						);
					}
				}
			} finally {
				try {
					await closeProductionEvaluation(machines, input.userId, attempt);
				} finally {
					if (snapshotId)
						await machines.destroySnapshot(AuthSnapshotId(snapshotId));
				}
			}
		}
		const afterQuota = await readCodexSubscriptionUsage(input.userId);
		await writeFile(
			join(directory, "results.json"),
			redactEvaluationText(
				JSON.stringify(
					{
						status: "pilot-only-not-parity",
						results,
						beforeQuota,
						afterQuota,
						limitations: [
							"Native CLI does not expose the product request-count guard or a hard token-output cap.",
							"Token threshold is observed after each response; a last request can exceed it.",
							"VM provider cost must be reconciled independently; no invented dollar total.",
							"Resource and network equivalence requires operator verification before any parity claim.",
						],
					},
					null,
					2,
				),
			),
			{ mode: 0o600 },
		);
		return directory;
	} finally {
		await closeJobQueueForTests();
		await closeDatabase();
	}
}
