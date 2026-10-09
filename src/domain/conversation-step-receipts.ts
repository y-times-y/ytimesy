import {
	MODEL_WORKFLOW_DEADLINE_MS,
	type WorkflowStep,
	type WorkflowStepOutcome,
} from "./model-workflow";

export type StepReceipt = {
	state: "processing" | "done";
	outcome: WorkflowStepOutcome | null;
	startedAt: number;
};

/** Storage operations must be synchronous inside one chat's Durable Object. */
export interface ConversationStepStorage {
	read(step: WorkflowStep): StepReceipt | undefined;
	firstStartedAt(step: WorkflowStep): number | undefined;
	insert(step: WorkflowStep, startedAt: number): void;
	finish(step: WorkflowStep, outcome: WorkflowStepOutcome): boolean;
}

/** A receipt with an unknown outcome is a replay fence, never permission to retry inference. */
export function claimConversationStep(
	storage: ConversationStepStorage,
	step: WorkflowStep,
	now = Date.now(),
):
	| { kind: "claimed"; remainingMs: number }
	| { kind: "done"; outcome: WorkflowStepOutcome }
	| { kind: "unavailable" } {
	const existing = storage.read(step);
	if (existing?.state === "done" && existing.outcome)
		return { kind: "done", outcome: existing.outcome };
	if (existing) return { kind: "unavailable" };
	if (step.index > 1) {
		const previous = storage.read({ ...step, index: step.index - 1 });
		if (previous?.state !== "done" || previous.outcome !== "continue")
			return { kind: "unavailable" };
	}
	const firstStartedAt = storage.firstStartedAt(step) ?? now;
	storage.insert(step, now);
	return {
		kind: "claimed",
		remainingMs: Math.max(
			0,
			MODEL_WORKFLOW_DEADLINE_MS - (now - firstStartedAt),
		),
	};
}
