import {
	BUDGET_BLOCKED_MESSAGE,
	type BudgetState,
	budgetAppliesTo,
	cloudflareBudgetUsers,
	globalBudgetMode,
	isSpendingCapError,
	type TurnAdmission,
	turnAdmission,
} from "../../domain/cloudflare-budget";
import { durableObjectLocation } from "./durable-object-location";
import type { EdgeExecutorEnvironment } from "./environment";

/**
 * For users in YTIMESY_CF_BUDGET_USERS only, reads the user's monthly compute state from their hub and decides whether a
 * claimed turn starts (degraded or not) or is held in the queue. Fails open:
 * an unreadable hub never stops a turn, except Cloudflare's own spending-cap
 * refusal, which holds it with the budget message.
 */
export async function budgetAdmission(
	env: Pick<EdgeExecutorEnvironment, "USER_HUBS">,
	userId: string,
): Promise<TurnAdmission> {
	const mode = globalBudgetMode(process.env.YTIMESY_CF_BUDGET_GLOBAL);
	if (mode === "pause") return turnAdmission(null, mode);
	// The per-user budget is opt-in (YTIMESY_CF_BUDGET_USERS): an unlisted user
	// is never read from the hub or held; only the global switch reaches them.
	if (
		!budgetAppliesTo(
			cloudflareBudgetUsers(process.env.YTIMESY_CF_BUDGET_USERS),
			userId,
		)
	)
		return turnAdmission(null, mode);
	let state: BudgetState | null = null;
	try {
		state = (
			await env.USER_HUBS.getByName(userId, durableObjectLocation()).usage()
		).state;
	} catch (error) {
		if (isSpendingCapError(error))
			return {
				action: "hold",
				degraded: true,
				message: BUDGET_BLOCKED_MESSAGE,
			};
		console.warn("Compute budget was not read; admitting the turn.", {
			cause: error instanceof Error ? error.name : "unknown",
		});
	}
	return turnAdmission(state, mode);
}
