import { z } from "zod";
import {
	parallelWorkPlan,
	scheduleParallelWork,
} from "#/domain/parallel-work-plan";

const readyTask = parallelWorkPlan.shape.tasks.element
	.omit({ estimatedSeconds: true, dependsOn: true, objective: true })
	.extend({
		title: z.string().trim().min(1).max(200),
		prompt: z.string().min(1).max(32000),
		owns: parallelWorkPlan.shape.tasks.element.shape.owns.min(1),
		modelId: z.string().min(1).optional(),
		harness: z.enum(["codex", "claude", "api"]).optional(),
	});

export const readyTaskLaunch = z.object({
	tasks: z.array(readyTask).min(2).max(5),
});

/** One inference can dispatch independent contracts; the existing executor still owns admission and journaling. */
export async function launchReadyTasks(input: {
	request: z.infer<typeof readyTaskLaunch>;
	available: () => Promise<number>;
	launch: (task: z.infer<typeof readyTask>, index: number) => Promise<unknown>;
	signal: AbortSignal;
}) {
	const { tasks } = readyTaskLaunch.parse(input.request);
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
	return {
		tasks: results.map((result, index) => ({
			id: tasks[index].id,
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
