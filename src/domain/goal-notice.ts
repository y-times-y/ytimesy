import type { Goal, GoalStopReason } from "./goal";
import { SessionItemId } from "./ids";
import type {
	NoticeSessionItem,
	SessionItem,
	SessionTurnStatus,
} from "./session-item";

/**
 * The turn's goal as a session item (a notice), so it is saved with the
 * turn's other items across durable steps and the composer reads it from the
 * same stream as everything else. One per turn, replaced as the goal moves.
 */
const GOAL_SUFFIX = ":goal";

/** What the model started it with, shown while it runs. */
const objectiveLine = (objective: string) =>
	objective.length > 160 ? `${objective.slice(0, 160)}…` : objective;

const STOP_TEXT: Record<GoalStopReason, string> = {
	complete: "Goal complete",
	blocked: "Goal blocked",
	deadline: "Goal stopped: time limit reached",
	"no-progress": "Goal stopped: no progress",
	"max-continuations": "Goal stopped: continuation limit reached",
};

export function goalNoticeMessage(goal: Goal) {
	const head =
		goal.status === "active"
			? "Goal mode"
			: ((goal.stopReason ? STOP_TEXT[goal.stopReason] : null) ??
				`Goal ${goal.status}`);
	return `${head}: ${objectiveLine(goal.objective)}`;
}

/**
 * `toolMark`: how many of the turn's items existed when the last
 * continuation went out, to count the tool calls made since.
 */
export function goalNoticeItem(
	turnId: string,
	goal: Goal,
	toolMark: number,
): NoticeSessionItem {
	return {
		kind: "notice",
		id: SessionItemId(`${turnId}${GOAL_SUFFIX}`),
		message: goalNoticeMessage(goal),
		goal: { state: goal, toolMark },
	};
}

/** The turn's goal notice, if the model started one. */
export function goalOfTurn(items: readonly SessionItem[], turnId: string) {
	const id = `${turnId}${GOAL_SUFFIX}`;
	for (let index = items.length - 1; index >= 0; index--) {
		const item = items[index];
		if (item.kind === "notice" && item.goal && item.id === id) return item.goal;
	}
	return null;
}

/** The items with the turn's goal notice added or replaced in place. */
export function withGoalNotice(
	items: readonly SessionItem[],
	notice: NoticeSessionItem,
): SessionItem[] {
	const at = items.findIndex(
		(item) => item.kind === "notice" && item.goal && item.id === notice.id,
	);
	if (at < 0) return [...items, notice];
	return items.map((item, index) => (index === at ? notice : item));
}

/**
 * The goal the composer announces: the last goal notice, while it is active
 * and its turn still runs.
 */
export function activeGoal(
	items: readonly SessionItem[],
	turnStatus: SessionTurnStatus,
): { objective: string; continuations: number } | null {
	if (turnStatus !== "running") return null;
	for (let index = items.length - 1; index >= 0; index--) {
		const item = items[index];
		if (item.kind !== "notice" || !item.goal) continue;
		const goal = item.goal.state;
		return goal.status === "active"
			? { objective: goal.objective, continuations: goal.continuations }
			: null;
	}
	return null;
}

/** Tool-like cards a turn produced, for counting progress between continuations. */
export function turnToolCards(items: readonly SessionItem[], turnId: string) {
	const own = `${turnId}:`;
	return items.filter(
		(item) =>
			item.id.startsWith(own) &&
			(item.kind === "commandExecution" ||
				item.kind === "fileChange" ||
				item.kind === "mcpToolCall" ||
				(item.kind === "dynamicToolCall" && item.tool !== "goal")),
	).length;
}
