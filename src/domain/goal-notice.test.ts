import { describe, expect, it } from "vitest";
import { newGoal } from "./goal";
import {
	activeGoal,
	goalNoticeItem,
	goalOfTurn,
	turnToolCards,
	withGoalNotice,
} from "./goal-notice";
import type { SessionItem } from "./session-item";

const goal = newGoal({ objective: "Ship the feature", deadlineAtMs: null });

describe("goal notice", () => {
	it("is added once and replaced in place", () => {
		const first = withGoalNotice([], goalNoticeItem("t1", goal, -1));
		const next = withGoalNotice(
			first,
			goalNoticeItem("t1", { ...goal, continuations: 2 }, 4),
		);
		expect(next).toHaveLength(1);
		expect(goalOfTurn(next, "t1")).toMatchObject({
			toolMark: 4,
			state: { continuations: 2 },
		});
		expect(goalOfTurn(next, "t2")).toBeNull();
	});

	it("shows in the composer only while active and running", () => {
		const items: SessionItem[] = [goalNoticeItem("t1", goal, -1)];
		expect(activeGoal(items, "running")).toEqual({
			objective: "Ship the feature",
			continuations: 0,
		});
		expect(activeGoal(items, "completed")).toBeNull();
		const done = withGoalNotice(
			items,
			goalNoticeItem("t1", { ...goal, status: "complete" }, -1),
		);
		expect(activeGoal(done, "running")).toBeNull();
	});

	it("counts no goal-tool calls as progress", () => {
		expect(turnToolCards([], "t1")).toBe(0);
	});
});
