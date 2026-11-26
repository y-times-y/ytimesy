import { SessionItemId } from "./ids";
import type { NoticeSessionItem, SessionItem } from "./session-item";

export const STARTING_MACHINE_TEXT = "Starting your workspace…";

/**
 * Shown while a turn waits out a machine refusal that passes (the provider's
 * account limit, our hourly count): the turn is retried by its executor, so
 * the person sees a calm status, never the refusal.
 */
export function startingMachineItem(turnId: string): NoticeSessionItem {
	return {
		kind: "notice",
		id: SessionItemId(`${turnId}:starting-machine`),
		message: STARTING_MACHINE_TEXT,
		startingMachine: true,
	};
}

export function withoutStartingMachine(
	items: readonly SessionItem[],
): SessionItem[] {
	return items.filter(
		(item) => !(item.kind === "notice" && item.startingMachine),
	);
}
