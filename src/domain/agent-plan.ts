import type { SessionItem } from "./session-item";

/** The agent locks edits with this tool; they stay locked until the user approves. */
export const ENTER_PLAN_MODE_TOOL = "enter_plan_mode";
/** The agent submits its plan with this tool; the turn ends and waits for the user. */
export const PROPOSE_PLAN_TOOL = "propose_plan";
export const PLAN_TEXT_LIMIT = 20_000;

export type AgentPlanState =
	/** No plan in progress: the agent may edit. */
	| { readonly kind: "none" }
	/** The agent entered plan mode during the current turn and has not proposed yet. */
	| { readonly kind: "planning" }
	/** A proposed plan waits for the user; any reply without approval asks for a revision. */
	| { readonly kind: "proposed"; readonly planId: SessionItem["id"] };

/**
 * Where planning stands before the next step or turn, from the transcript alone.
 * A proposed plan stays until it is approved; other replies are feedback on it.
 * Entering plan mode locks only the turn that entered it: a turn that ended
 * without proposing (stopped, failed, or the agent never proposed) shows the
 * user nothing to approve, so it must not lock the turns after it.
 */
export function agentPlanState(items: readonly SessionItem[]): AgentPlanState {
	let laterTurn = false;
	for (let index = items.length - 1; index >= 0; index--) {
		const item = items[index];
		if (item.kind === "userMessage") {
			if (item.approvesPlan) return { kind: "none" };
			laterTurn = true;
		}
		if (item.kind === "planProposal")
			return { kind: "proposed", planId: item.id };
		if (
			!laterTurn &&
			item.kind === "dynamicToolCall" &&
			item.tool === ENTER_PLAN_MODE_TOOL &&
			item.status === "completed"
		)
			return { kind: "planning" };
	}
	return { kind: "none" };
}

/** The plan that still waits for the user's approval, if any. */
export function pendingPlanId(items: readonly SessionItem[]) {
	const state = agentPlanState(items);
	return state.kind === "proposed" ? state.planId : null;
}

/** How a proposed plan was answered, for its card. */
export function planOutcome(
	items: readonly SessionItem[],
	planId: SessionItem["id"],
): "pending" | "approved" | "revised" {
	const index = items.findIndex((item) => item.id === planId);
	for (const item of items.slice(index + 1)) {
		if (item.kind === "userMessage")
			return item.approvesPlan ? "approved" : "revised";
	}
	return "pending";
}

export const PLAN_APPROVAL_TEXT = "Approved. Implement the plan.";
