import { z } from "zod";

export const MAX_WORKFLOW_MODEL_STEPS = 30;
export const MODEL_WORKFLOW_DEADLINE_MS = 30 * 60 * 1000;
export const workflowTurnSchema = z
	.object({
		turnId: z.uuid(),
		leaseId: z.uuid(),
	})
	.strict();
export const workflowStepSchema = workflowTurnSchema.extend({
	index: z
		.number()
		.int()
		.min(1)
		.max(MAX_WORKFLOW_MODEL_STEPS + 1),
});
export type WorkflowTurn = z.infer<typeof workflowTurnSchema>;
export type WorkflowStep = z.infer<typeof workflowStepSchema>;
export type WorkflowStepOutcome =
	| "continue"
	| "completed"
	| "failed"
	| "cancelled";

/** Shared by Cloudflare and contract tests; every recorded step contains references only. */
export async function driveModelWorkflow(
	turn: WorkflowTurn,
	recordedStep: (
		name: string,
		run: () => Promise<WorkflowStepOutcome>,
	) => Promise<WorkflowStepOutcome>,
	execute: (request: WorkflowStep) => Promise<WorkflowStepOutcome>,
) {
	for (let index = 1; index <= MAX_WORKFLOW_MODEL_STEPS + 1; index++) {
		const outcome = await recordedStep(`model-step-${index}`, () =>
			execute({ ...turn, index }),
		);
		if (outcome !== "continue") return { outcome };
	}
	throw new Error("Durable executor exceeded its bounded step contract.");
}
