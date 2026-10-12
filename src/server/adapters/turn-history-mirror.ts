import { AsyncLocalStorage } from "node:async_hooks";
import type { ModelMessage } from "ai";
import type { SessionItem } from "#/domain/session-item";

/**
 * Receives every turn write the executor makes, tagged with the row version
 * (api_turn.updated_at) it produced, so the chat Durable Object can keep the
 * turn's history locally instead of reading it back from Postgres each step.
 */
export type TurnHistoryMirror = (
	turnId: string,
	version: string,
	history: { messages?: ModelMessage[]; items: readonly SessionItem[] },
) => void;

const mirror = new AsyncLocalStorage<TurnHistoryMirror>();

export function withTurnHistoryMirror<T>(
	target: TurnHistoryMirror,
	run: () => Promise<T>,
) {
	return mirror.run(target, run);
}

export function mirrorTurnHistory(...args: Parameters<TurnHistoryMirror>) {
	mirror.getStore()?.(...args);
}
