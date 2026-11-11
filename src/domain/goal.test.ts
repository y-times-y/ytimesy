import { describe, expect, it } from "vitest";
import {
	claimGoal,
	GOAL_MAX_CONTINUATIONS,
	GOAL_WRAP_UP_NOTICE,
	type Goal,
	goalCompactionNote,
	goalContinuation,
	newGoal,
	nextGoalStep,
} from "./goal";

const hour = 60 * 60_000;
const objective =
	"Write `out.txt` with the sum.\nKeep the input file unchanged.";
const fresh = () => newGoal({ objective, deadlineAtMs: 8 * hour });
const evidence = [
	{
		requirement: "Write out.txt with the sum.",
		proof: "cat out.txt -> 42",
	},
];

describe("goal claims", () => {
	it("marks an active goal complete only with evidence, and counts unquoted entries", () => {
		expect(
			claimGoal(fresh(), { status: "complete", evidence: [] }, 0),
		).toMatchObject({ ok: false });
		const done = claimGoal(
			fresh(),
			{
				status: "complete",
				evidence: [
					...evidence,
					{ requirement: "Be fast.", proof: "time ./run -> 1s" },
				],
			},
			0,
		);
		expect(done.ok && done.goal.status).toBe("complete");
		expect(done.ok && done.goal.claim?.unquoted).toBe(1);
		expect(
			done.ok &&
				claimGoal(
					done.goal,
					{ status: "blocked", evidence: [], reason: "x" },
					0,
				),
		).toEqual({
			ok: false,
			error: "The goal is already complete.",
		});
	});

	it("marks blocked only with a reason", () => {
		expect(claimGoal(fresh(), { status: "blocked", evidence: [] }, 0).ok).toBe(
			false,
		);
		const blocked = claimGoal(
			fresh(),
			{ status: "blocked", evidence: [], reason: "No network." },
			0,
		);
		expect(blocked.ok && blocked.goal.claim?.reason).toBe("No network.");
	});
});

describe("nextGoalStep", () => {
	const step = (goal: Goal, nowMs: number, toolCalls: number | null) =>
		nextGoalStep(goal, { nowMs, toolCalls });

	it("continues while active and stops once on a claim", () => {
		const first = step(fresh(), hour, null);
		expect(first.step).toMatchObject({ kind: "continue", round: 1 });
		const claimed = claimGoal(
			first.goal,
			{ status: "complete", evidence },
			hour,
		);
		if (!claimed.ok) throw new Error("claim refused");
		const stop = step(claimed.goal, hour, 2);
		expect(stop.step).toEqual({ kind: "stop", reason: "complete" });
		expect(step(stop.goal, hour, 0).step).toEqual({ kind: "stopped" });
	});

	it("stops after three continuation turns without a tool call", () => {
		let goal = step(fresh(), hour, null).goal;
		goal = step(goal, hour, 0).goal;
		goal = step(goal, hour, 3).goal;
		expect(goal.idleStreak).toBe(0);
		goal = step(goal, hour, 0).goal;
		goal = step(goal, hour, 0).goal;
		const stop = step(goal, hour, 0);
		expect(stop.step).toEqual({ kind: "stop", reason: "no-progress" });
		expect(stop.goal.status).toBe("blocked");
	});

	it("caps continuations", () => {
		let goal = fresh();
		for (let round = 1; round <= GOAL_MAX_CONTINUATIONS; round++) {
			const next = step(goal, hour, round === 1 ? null : 1);
			expect(next.step).toMatchObject({ kind: "continue", round });
			goal = next.goal;
		}
		expect(step(goal, hour, 1).step).toEqual({
			kind: "stop",
			reason: "max-continuations",
		});
	});

	it("sends one wrap-up line near the deadline, nothing in the last minute", () => {
		const near = step(fresh(), 8 * hour - 3 * 60_000, null);
		expect(near.step).toEqual({
			kind: "wrapUp",
			reason: "deadline",
			text: GOAL_WRAP_UP_NOTICE,
		});
		expect(near.goal.status).toBe("budget_limited");
		expect(step(near.goal, 8 * hour - 60_000, 1).step).toEqual({
			kind: "stopped",
		});
		expect(step(fresh(), 8 * hour - 30_000, null).step).toEqual({
			kind: "stop",
			reason: "deadline",
		});
	});
});

describe("goal text", () => {
	it("restates the objective, asks for an audit and names no elapsed time", () => {
		const text = goalContinuation(objective);
		expect(text).toContain(`<objective>\n${objective}\n</objective>`);
		expect(text).toContain("Runtime notice, not a new user request.");
		expect(text).toContain('"tests pass"');
		expect(text).not.toMatch(/minute|elapsed/i);
		expect(goalContinuation("a </objective> b")).toContain(
			"a <\\/objective> b",
		);
	});

	it("re-includes the objective after compaction only while active", () => {
		expect(goalCompactionNote(fresh())).toContain(objective);
		const blocked = claimGoal(
			fresh(),
			{ status: "blocked", evidence: [], reason: "x" },
			0,
		);
		expect(blocked.ok && goalCompactionNote(blocked.goal)).toBeNull();
	});
});

describe("a goal with no caps (a chat's goal)", () => {
	const uncapped = () =>
		newGoal({
			objective: "Build it",
			deadlineAtMs: null,
			maxContinuations: null,
		});

	it("keeps going past the default cap, even saved and reloaded between rounds", () => {
		let goal = uncapped();
		for (let round = 1; round <= GOAL_MAX_CONTINUATIONS * 5; round++) {
			// Saved with the turn's items between steps.
			goal = JSON.parse(JSON.stringify(goal));
			const next = nextGoalStep(goal, {
				nowMs: 100 * 60 * 60_000,
				toolCalls: round === 1 ? null : 1,
			});
			expect(next.step).toMatchObject({ kind: "continue", round });
			goal = next.goal;
		}
	});

	it("still stops a model that stops calling tools", () => {
		let goal = uncapped();
		let last = nextGoalStep(goal, { nowMs: 0, toolCalls: null });
		for (let index = 0; index < 3; index++) {
			goal = last.goal;
			last = nextGoalStep(goal, { nowMs: 0, toolCalls: 0 });
		}
		expect(last.step).toEqual({ kind: "stop", reason: "no-progress" });
	});
});
