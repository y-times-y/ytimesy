import type { ModelMessage } from "ai";
import type { SessionItem } from "../../domain/session-item";
import { lastUserMessageIndex } from "../adapters/turn-items-storage";

/**
 * One log line per chat step with the size of the history it works on, and the
 * isolate's heap where the runtime reports it, so memory resets can be tied to
 * chat size. Serialized bytes are measured only when the history was just read
 * from the database (the string it costs is as large as the history).
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
		console.info(
			JSON.stringify({
				event: "turn.step_sizes",
				turnId,
				source,
				messages: history.messages.length,
				items: history.items.length,
				itemsAfterLastUserMessage: activeTurnItems,
				...(source === "database"
					? {
							messagesBytes: JSON.stringify(history.messages).length,
							itemsBytes: JSON.stringify(history.items).length,
						}
					: {}),
				...(heap === undefined ? {} : { heapUsedBytes: heap }),
			}),
		);
	} catch {
		// Bookkeeping only.
	}
}
