import { expect, it } from "vitest";
import { agentPlanState, pendingPlanId, planOutcome } from "./agent-plan";
import { applyApiProgress } from "./api-progress";
import { SessionItemId } from "./ids";
import type { SessionItem } from "./session-item";

const user = (id: string, approvesPlan = false): SessionItem => ({
	kind: "userMessage",
	id: SessionItemId(id),
	text: approvesPlan ? "Approved. Implement the plan." : "Rework billing",
	...(approvesPlan ? { approvesPlan: true as const } : {}),
});
const plan = (id: string): SessionItem => ({
	kind: "planProposal",
	id: SessionItemId(id),
	text: "1. Split invoices",
});
const entered: SessionItem = {
	kind: "dynamicToolCall",
	id: SessionItemId("t1:enter"),
	tool: "enter_plan_mode",
	status: "completed",
};

it("is off until the agent enters plan mode", () => {
	expect(agentPlanState([user("u1")])).toEqual({ kind: "none" });
	expect(agentPlanState([user("u1"), entered])).toEqual({ kind: "planning" });
});

it("keeps a proposed plan waiting through feedback until it is approved", () => {
	const proposed = [user("u1"), entered, plan("t1:p")];
	expect(agentPlanState(proposed)).toEqual({
		kind: "proposed",
		planId: "t1:p",
	});
	expect(planOutcome(proposed, SessionItemId("t1:p"))).toBe("pending");
	const feedback = [...proposed, user("u2")];
	expect(pendingPlanId(feedback)).toBe("t1:p");
	expect(planOutcome(feedback, SessionItemId("t1:p"))).toBe("revised");
	const revised = [...feedback, plan("t2:p")];
	expect(pendingPlanId(revised)).toBe("t2:p");
	const approved = [...revised, user("u3", true)];
	expect(agentPlanState(approved)).toEqual({ kind: "none" });
	expect(planOutcome(approved, SessionItemId("t2:p"))).toBe("approved");
});

it("records propose_plan as a plan item, not a tool row", () => {
	const called = applyApiProgress([user("u1")], "t1", {
		type: "tool-call",
		id: "c1",
		name: "propose_plan",
		input: { plan: "  ## Plan\n1. Split invoices  " },
	});
	expect(called.at(-1)).toEqual({
		kind: "planProposal",
		id: "t1:c1",
		text: "## Plan\n1. Split invoices",
	});
	expect(
		applyApiProgress(called, "t1", {
			type: "tool-result",
			id: "c1",
			name: "propose_plan",
			output: { proposed: true },
		}),
	).toEqual(called);
	expect(
		applyApiProgress([user("u1")], "t1", {
			type: "tool-call",
			id: "c2",
			name: "propose_plan",
			input: { plan: " " },
		}),
	).toHaveLength(1);
});
