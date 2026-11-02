import { ApiTurnCancelled } from "#/domain/api-turn-failure";

/**
 * The turns this process (a chat's Durable Object, or a local worker) is
 * running now, by turn id. Stop aborts one here at once: its model stream and
 * its commands stop on the spot instead of at the next heartbeat (up to a
 * second later, or a progress write that a turn waiting on a tool never makes).
 * The durable cancel flag stays the source of truth; this is only the fast path.
 */
const running = new Map<string, Set<(reason: unknown) => void>>();

export function registerLiveTurn(
	turnId: string,
	abort: (reason: unknown) => void,
): () => void {
	const aborts = running.get(turnId) ?? new Set();
	running.set(turnId, aborts);
	aborts.add(abort);
	return () => {
		aborts.delete(abort);
		if (!aborts.size && running.get(turnId) === aborts) running.delete(turnId);
	};
}

/** Aborts the turn if it runs in this process; true when it did. */
export function abortLiveTurn(turnId: string): boolean {
	const aborts = running.get(turnId);
	if (!aborts?.size) return false;
	for (const abort of [...aborts]) abort(new ApiTurnCancelled());
	return true;
}
