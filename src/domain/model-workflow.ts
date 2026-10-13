import { z } from "zod";

const COORDINATION_MODEL_STEPS = 30;
const IMPLEMENTATION_MODEL_STEPS = 128;
export const MAX_WORKFLOW_MODEL_STEPS = IMPLEMENTATION_MODEL_STEPS;
export const MODEL_WORKFLOW_DEADLINE_MS = 30 * 60 * 1000;

/** More tool iterations do not extend a turn's deadline or bypass token admission. */
export function modelStepLimit(surface: "coordination" | "implementation") {
	return surface === "implementation"
		? IMPLEMENTATION_MODEL_STEPS
		: COORDINATION_MODEL_STEPS;
}
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
