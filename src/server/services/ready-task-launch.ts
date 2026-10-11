import { z } from "zod";
import {
	parallelWorkPlan,
	scheduleParallelWork,
} from "#/domain/parallel-work-plan";
import { verificationCommandIdentity } from "#/domain/task-verification-assignment";

const checkCommands = z.array(z.string().trim().min(1).max(2048)).min(1).max(8);

const readyTask = parallelWorkPlan.shape.tasks.element
	.omit({ estimatedSeconds: true, dependsOn: true, objective: true })
	.extend({
		title: z.string().trim().min(1).max(200),
		// Same brief bound as create_task; ownership and checks are appended by the server.
		prompt: z.string().min(1).max(2500),
		owns: parallelWorkPlan.shape.tasks.element.shape.owns.min(1),
		focusedChecks: checkCommands,
		verificationPaths: parallelWorkPlan.shape.tasks.element.shape.owns
			.min(1)
			.max(8),
		modelId: z.string().min(1).optional(),
		harness: z.enum(["codex", "claude", "api"]).optional(),
	});

export const readyTaskLaunch = z.object({
	tasks: z.array(readyTask).min(2).max(5),
	finalChecks: checkCommands,
	perBuilderChecks: z
		.array(z.string().trim().min(1).max(2048))
		.max(8)
		.default([]),
	performancePlan: z
		.object({
			singleBuilderSeconds: z.number().positive(),
			parallelBuilderSeconds: z.number().positive(),
			additionalCoordinationSeconds: z.number().nonnegative(),
		})
		.optional(),
});

export function readyTaskPrompt(
	task: z.infer<typeof readyTask>,
	verification: Pick<
		z.infer<typeof readyTaskLaunch>,
		"finalChecks" | "perBuilderChecks"
	>,
) {
	return `${task.prompt}\n\nDeclared write ownership: ${JSON.stringify(task.owns)}. Keep implementation within these paths; report necessary scope changes before editing outside them.\nVerification assignment: run these focused checks: ${JSON.stringify(task.focusedChecks)}, binding receipts to these exact source files (not directories): ${JSON.stringify(task.verificationPaths)}. Include any additional changed sources in the receipts and handoff. Repository-required per-builder checks: ${JSON.stringify(verification.perBuilderChecks)}. The lead owns one combined final verification pass: ${JSON.stringify(verification.finalChecks)}. Do not duplicate that combined pass unless original user/repository policy or a concrete failure requires it. Preserve all original requirements. First handoff: exact scoped diff, actual command/output references and remaining final checks; never describe focused checks as full verification.`;
}

/** One inference can dispatch independent contracts; the existing executor still owns admission and journaling. */
export async function launchReadyTasks(input: {
	request: z.infer<typeof readyTaskLaunch>;
	available: () => Promise<number>;
	launch: (task: z.infer<typeof readyTask>, index: number) => Promise<unknown>;
	prepareIntegration?: () => Promise<unknown>;
	signal: AbortSignal;
}) {
	const { tasks, finalChecks, perBuilderChecks, performancePlan } =
		readyTaskLaunch.parse(input.request);
	if (
		performancePlan &&
		performancePlan.parallelBuilderSeconds +
			performancePlan.additionalCoordinationSeconds >=
			performancePlan.singleBuilderSeconds
	)
		throw new Error(
			"Parallel estimates do not cover coordination overhead. No tasks created; use one coherent builder with complete final verification. Estimates are advisory, not measured performance.",
		);
	for (const task of tasks)
		if (
			task.verificationPaths.some(
				(path) =>
					!task.owns.some(
						(owned) =>
							path === owned || path.startsWith(`${owned.replace(/\/$/, "")}/`),
					),
			)
		)
			throw new Error(
				"Verification files must be within declared ownership. No tasks created.",
			);
	for (const task of tasks)
		for (const command of task.focusedChecks)
			if (
				finalChecks.some(
					(final) =>
						verificationCommandIdentity(final) ===
						verificationCommandIdentity(command),
				) &&
				!perBuilderChecks.some(
					(required) =>
						verificationCommandIdentity(required) ===
						verificationCommandIdentity(command),
				)
			)
				throw new Error(
					"A check is assigned to both builders and final integration. Assign it once, or explicitly declare the repository-required per-builder exception. No tasks created.",
				);
	if (
		perBuilderChecks.some(
			(command) =>
				!finalChecks.some(
					(final) =>
						verificationCommandIdentity(final) ===
						verificationCommandIdentity(command),
				),
		)
	)
		throw new Error(
			"Per-builder exceptions must identify final checks required by repository policy. No tasks created.",
		);
	// Reuse the existing ownership validator; estimates here are irrelevant to launch order.
	scheduleParallelWork(
		{
			tasks: tasks.map((task) => ({
				id: task.id,
				objective: task.title,
				owns: task.owns,
				estimatedSeconds: 1,
				dependsOn: [],
			})),
		},
		5,
	);
	input.signal.throwIfAborted();
	if (tasks.length > (await input.available()))
		throw new Error(
			"Insufficient capacity for this ready batch. No tasks created; reduce the batch or wait for existing children.",
		);
	input.signal.throwIfAborted();
	const results = await Promise.allSettled(
		tasks.map(async (task, index) => input.launch(task, index)),
	);
	let integration: unknown;
	if (
		input.prepareIntegration &&
		results.every(
			(result) =>
				result.status === "fulfilled" &&
				z
					.object({ taskId: z.string(), startError: z.never().optional() })
					.safeParse(result.value).success,
		)
	) {
		input.signal.throwIfAborted();
		try {
			integration = await input.prepareIntegration();
		} catch {
			integration = {
				status: "unavailable",
				instruction:
					"Inspect existing drafts before creating an integration task; preparation may have partial effects. Builders were not replayed.",
			};
		}
	}
	return {
		kind: "ready-task-verification-v1",
		...(integration
			? {
					integration,
					integrationControl: "server",
					integrationInstruction:
						"Do not start or message the integration draft. Review completed siblings and use mark_task_reviewed to stage their exact accepted patches. After every batch source is reviewed, use integrate_reviewed_tasks on this draft with the complete source list and final checks. Only a visible integration failure permits model repair.",
				}
			: {}),
		...(performancePlan ? { performancePlan } : {}),
		finalVerification: {
			commands: finalChecks,
			sourcePaths: tasks.flatMap((task) => task.verificationPaths),
			perBuilderChecks,
			instruction:
				"Retain this assignment for the integration checkout. Automated integration preserves clean-baseline checks; supply any additional original-contract checks. These commands are requirements, not execution evidence.",
		},
		tasks: results.map((result, index) => ({
			id: tasks[index].id,
			focusedChecks: tasks[index].focusedChecks,
			verificationPaths: tasks[index].verificationPaths,
			owns: tasks[index].owns,
			...(result.status === "fulfilled"
				? { result: result.value }
				: {
						status: "uncertain",
						instruction:
							"Inspect existing tasks and durable receipts before continuing. This launch may have partial effects; do not create a replacement or replay the batch.",
					}),
		})),
	};
}
