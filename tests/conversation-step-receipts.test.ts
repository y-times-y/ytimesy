import { describe, expect, it } from "vitest";
import {
	type ConversationStepStorage,
	claimConversationStep,
	type StepReceipt,
} from "../src/domain/conversation-step-receipts";
import type { WorkflowStep } from "../src/domain/model-workflow";

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
	it("requires the predecessor and never expires a long turn", () => {
		const receipts = storage();
		const next = { ...step, index: 2 };
		expect(claimConversationStep(receipts, next)).toEqual({
			kind: "unavailable",
		});
		claimConversationStep(receipts, step, 100);
		receipts.finish(step, "continue");
		expect(claimConversationStep(receipts, next, 1100)).toEqual({
			kind: "claimed",
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
	it("lets only an explicit resume re-run an interrupted step", () => {
		const receipts = storage();
		claimConversationStep(receipts, step, 100);
		expect(claimConversationStep(receipts, step, 700)).toEqual({
			kind: "unavailable",
		});
		expect(claimConversationStep(receipts, step, 700, true)).toEqual({
			kind: "claimed",
			resumed: true,
		});
		receipts.finish(step, "continue");
		expect(claimConversationStep(receipts, step, 800, true)).toEqual({
			kind: "done",
			outcome: "continue",
		});
	});
});
