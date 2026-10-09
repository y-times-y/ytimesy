import { describe, expect, it } from "vitest";
import {
	type ConversationStepStorage,
	claimConversationStep,
	type StepReceipt,
} from "../src/domain/conversation-step-receipts";
import {
	MODEL_WORKFLOW_DEADLINE_MS,
	type WorkflowStep,
} from "../src/domain/model-workflow";

const step: WorkflowStep = {
	turnId: "00000000-0000-4000-8000-000000000001",
	leaseId: "00000000-0000-4000-8000-000000000002",
	index: 1,
};
function storage(): ConversationStepStorage {
	const rows = new Map<string, StepReceipt>();
	const key = (value: WorkflowStep) => JSON.stringify(value);
	return {
		read: (value) => rows.get(key(value)),
		firstStartedAt: (value) => rows.get(key({ ...value, index: 1 }))?.startedAt,
		insert(value, startedAt) {
			if (rows.has(key(value))) throw new Error("Duplicate receipt");
			rows.set(key(value), { state: "processing", outcome: null, startedAt });
		},
		finish(value, outcome) {
			const receipt = rows.get(key(value));
			if (receipt?.state !== "processing") return false;
			rows.set(key(value), { ...receipt, state: "done", outcome });
			return true;
		},
	};
}
describe("chat-local step receipts", () => {
	it("fences an uncertain step instead of authorizing repeated inference", () => {
		const receipts = storage();
		expect(claimConversationStep(receipts, step, 100)).toEqual({
			kind: "claimed",
			remainingMs: MODEL_WORKFLOW_DEADLINE_MS,
		});
		expect(claimConversationStep(receipts, step, 200)).toEqual({
			kind: "unavailable",
		});
	});
	it("replays a completed result without executing again", () => {
		const receipts = storage();
		claimConversationStep(receipts, step);
		expect(receipts.finish(step, "continue")).toBe(true);
		expect(receipts.finish(step, "failed")).toBe(false);
		expect(claimConversationStep(receipts, step)).toEqual({
			kind: "done",
			outcome: "continue",
		});
	});
	it("requires the predecessor and preserves the original deadline", () => {
		const receipts = storage();
		const next = { ...step, index: 2 };
		expect(claimConversationStep(receipts, next)).toEqual({
			kind: "unavailable",
		});
		claimConversationStep(receipts, step, 100);
		receipts.finish(step, "continue");
		expect(claimConversationStep(receipts, next, 1100)).toEqual({
			kind: "claimed",
			remainingMs: MODEL_WORKFLOW_DEADLINE_MS - 1000,
		});
	});
	it("does not cross leases or continue after terminal outcomes", () => {
		const receipts = storage();
		claimConversationStep(receipts, step);
		receipts.finish(step, "completed");
		expect(claimConversationStep(receipts, { ...step, index: 2 })).toEqual({
			kind: "unavailable",
		});
		expect(
			claimConversationStep(receipts, { ...step, leaseId: "other", index: 2 }),
		).toEqual({ kind: "unavailable" });
	});
});
