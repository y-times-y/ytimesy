import { z } from "zod";

export const builderWorkUpdate = z
	.object({
		expectedRevision: z.number().int().nonnegative(),
		objective: z.string().min(1).max(2000),
		steps: z
			.array(
				z.object({
					step: z.string().min(1).max(300),
					status: z.enum(["pending", "in_progress", "completed", "blocked"]),
				}),
			)
			.min(1)
			.max(12),
		evidence: z.array(z.string().min(1).max(500)).max(12),
		remaining: z.array(z.string().min(1).max(500)).max(12),
	})
	.superRefine((value, context) => {
		if (value.steps.filter((step) => step.status === "in_progress").length > 1)
			context.addIssue({
				code: "custom",
				message: "Only one current step is allowed.",
			});
	});

export const builderWorkState = z.object({
	revision: z.number().int().positive(),
	objective: builderWorkUpdate.shape.objective,
	steps: builderWorkUpdate.shape.steps,
	evidence: builderWorkUpdate.shape.evidence,
	remaining: builderWorkUpdate.shape.remaining,
});
export type BuilderWorkState = z.infer<typeof builderWorkState>;
