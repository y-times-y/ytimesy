import { modelConcurrencyLimits } from "../adapters/agent-capacity";
import { claimApiTurn } from "../adapters/api-turns";
import type { WorkspaceMachines } from "../services/workspace-machines";

/**
 * Machines for a turn that has none: every call refuses, naming the call, so
 * a path that would copy or wake a VM fails loudly instead.
 */
export function refusingWorkspaceMachines(reason: string): WorkspaceMachines {
	return new Proxy({} as WorkspaceMachines, {
		get: (_target, name) =>
			// Not a thenable: awaiting the object must not call it.
			name === "then" || typeof name === "symbol"
				? undefined
				: () => Promise.reject(new Error(`${reason} (${String(name)})`)),
	});
}

/**
 * Runs the chat's queued `node` turn in this process (localTurnsEnabled, a
 * development server only). A turn another process claimed, or none, is
 * left alone; one never claimed stays queued, and Stop cancels it.
 */
export async function runQueuedLocalTurn(sessionId: string) {
	const turn = await claimApiTurn(
		2,
		modelConcurrencyLimits().fleet,
		"node",
		sessionId,
	);
	if (!turn) return null;
	const { runApiTurn } = await import("./api-turn");
	return runApiTurn(refusingWorkspaceMachines("Y² has no machine."), turn);
}
