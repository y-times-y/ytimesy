import { z } from "zod";
import { parallelWorkPlan, scheduleParallelWork } from "./parallel-work-plan";

export const durableWorkPlanRequest = z.object({
	tasks: z
		.array(
			parallelWorkPlan.shape.tasks.element.extend({
				taskId: z.uuid(),
				kind: z.enum(["task", "integration"]).default("task"),
			}),
		)
		.min(1)
		.max(12),
});

export const durableWorkPlan = z.object({
	type: z.literal("work-plan"),
	id: z.string().regex(/^[a-f0-9]{64}$/),
	status: z.enum(["active", "paused", "completed", "cancelled", "blocked"]),
	lease: z.object({ token: z.uuid(), until: z.number() }).nullable(),
	nodes: z
		.array(
			durableWorkPlanRequest.shape.tasks.element.extend({
				contract: z.string().regex(/^[a-f0-9]{64}$/),
				priority: z.number(),
				state: z.enum([
					"pending",
					"dispatching",
					"started",
					"done",
					"failed",
					"uncertain",
				]),
				message: z.string().max(1000).nullable(),
			}),
		)
		.min(1)
		.max(12),
});
export type DurableWorkPlan = z.infer<typeof durableWorkPlan>;

export function validateWorkPlan(raw: unknown) {
	const request = durableWorkPlanRequest.parse(raw);
	const schedule = scheduleParallelWork(request, 1);
	if (
		new Set(request.tasks.map((task) => task.taskId)).size !==
		request.tasks.length
	)
		throw new Error("A draft may occur only once in a plan.");
	for (const node of request.tasks) {
		if (new Set(node.dependsOn).size !== node.dependsOn.length)
			throw new Error("Prerequisites must be distinct.");
		if (node.kind === "task" && node.dependsOn.length > 1)
			throw new Error(
				"Multiple prerequisites require an explicit integration node, then a stacked task.",
			);
		if (
			node.kind === "integration" &&
			(node.dependsOn.length < 2 || node.dependsOn.length > 8)
		)
			throw new Error(
				"An integration node requires two to eight reviewed prerequisites.",
			);
	}
	return { request, schedule };
}
