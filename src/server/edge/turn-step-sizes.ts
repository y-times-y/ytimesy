import { Buffer } from "node:buffer";
import type { ModelMessage } from "ai";
import type { SessionItem } from "../../domain/session-item";
import { lastUserMessageIndex } from "../adapters/turn-items-storage";

/**
 * A step's history (messages plus items, serialized) above this is logged as
 * `turn.step_over_budget`. A Durable Object isolate has 128 MB shared with
 * other chats, and a step holds several live copies of its history (parsed,
 * cached, serialized for the model and the checkpoint), so megabytes of
 * history here are what production memory resets followed.
 */
export const STEP_HISTORY_BUDGET_BYTES = 2 * 1024 * 1024;

/** Whether a measured history is over the budget. */
export function stepHistoryOverBudget(
	messagesBytes: number,
	itemsBytes: number,
) {
	return messagesBytes + itemsBytes > STEP_HISTORY_BUDGET_BYTES;
}

/** Exact UTF-8 JSON-array size without allocating a string for the whole history. */
function historyArrayBytes(values: readonly unknown[]) {
	let bytes = 2 + Math.max(0, values.length - 1);
	for (const value of values)
		bytes += Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8");
	return bytes;
}

/**
 * One log line per chat step with the size of the history it works on, and the
 * isolate's heap where the runtime reports it, so memory resets can be tied to
 * chat size. Serialized bytes are measured only when the history was just read
 * from the database, serializing one entry at a time rather than copying the
 * whole history into a second string.
 * Never throws: it is bookkeeping and must not fail the step.
 */
export function logTurnStepSizes(
	turnId: string,
	history: { messages: ModelMessage[]; items: SessionItem[] },
	source: "database" | "cache",
) {
	try {
		const heap = (
			globalThis as {
				process?: { memoryUsage?: () => { heapUsed: number } };
			}
		).process?.memoryUsage?.().heapUsed;
		const activeTurnItems =
			history.items.length - (lastUserMessageIndex(history.items) + 1);
		// Only a single entry is copied at a time; cached steps avoid this walk.
		const sizes =
			source === "database"
				? {
						messagesBytes: historyArrayBytes(history.messages),
						itemsBytes: historyArrayBytes(history.items),
					}
				: null;
		if (sizes && stepHistoryOverBudget(sizes.messagesBytes, sizes.itemsBytes))
			console.warn(
				JSON.stringify({
					event: "turn.step_over_budget",
					turnId,
					...sizes,
					budgetBytes: STEP_HISTORY_BUDGET_BYTES,
				}),
			);
		console.info(
			JSON.stringify({
				event: "turn.step_sizes",
				turnId,
				source,
				messages: history.messages.length,
				items: history.items.length,
				itemsAfterLastUserMessage: activeTurnItems,
				...(sizes ?? {}),
				...(heap === undefined ? {} : { heapUsedBytes: heap }),
			}),
		);
	} catch {
		// Bookkeeping only.
	}
}
