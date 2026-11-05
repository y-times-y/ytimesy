import type { WorkflowStep, WorkflowStepOutcome } from "./model-workflow";

export type StepReceipt = {
	state: "processing" | "done";
	outcome: WorkflowStepOutcome | null;
	startedAt: number;
};

/** Storage operations must be synchronous inside one chat's Durable Object. */
export interface ConversationStepStorage {
	read(step: WorkflowStep): StepReceipt | undefined;
	insert(step: WorkflowStep, startedAt: number): void;
	finish(step: WorkflowStep, outcome: WorkflowStepOutcome): boolean;
}

/**
 * A receipt with an unknown outcome is a replay fence. Only the chat's own turn
 * loop may lift it, by resuming after a restart; the resumed step is told which
 * tool calls already ran instead of replaying them.
 */
export function claimConversationStep(
	storage: ConversationStepStorage,
	step: WorkflowStep,
	now = Date.now(),
	resume = false,
):
	| { kind: "claimed"; resumed?: true }
	| { kind: "done"; outcome: WorkflowStepOutcome }
	| { kind: "unavailable" } {
	const existing = storage.read(step);
	if (existing?.state === "done" && existing.outcome)
		return { kind: "done", outcome: existing.outcome };
	if (existing) {
		if (!resume) return { kind: "unavailable" };
		return { kind: "claimed", resumed: true };
	}
	if (step.index > 1) {
		const previous = storage.read({ ...step, index: step.index - 1 });
		if (previous?.state !== "done" || previous.outcome !== "continue")
			return { kind: "unavailable" };
	}
	storage.insert(step, now);
	return { kind: "claimed" };
}
