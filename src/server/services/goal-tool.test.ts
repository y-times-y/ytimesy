import { describe, expect, it } from "vitest";
import type { Goal } from "../../domain/goal";
import { goalTool } from "./goal-tool";

type Execute = (args: Record<string, unknown>) => Promise<string>;

function setup(canStart: boolean, goal: Goal | null = null) {
	const state = { goal };
	const started: Goal[] = [];
	const tools = goalTool({
		state,
		now: () => 1_000,
		canStart,
		onStart: (next) => started.push(next),
	});
	const run = (args: Record<string, unknown>) =>
		(tools.goal.execute as unknown as Execute)(args);
	return { state, started, run };
}

describe("goal tool start", () => {
	it("starts a goal with no time or round cap", async () => {
		const { state, started, run } = setup(true);
		expect(await run({ op: "get" })).toMatch(/No goal is set/);
		expect(await run({ op: "start", objective: "  Build it  " })).toMatch(
			/Goal mode is on/,
		);
		expect(state.goal).toMatchObject({
			objective: "Build it",
			status: "active",
			maxContinuations: null,
			deadlineAtMs: null,
		});
		expect(started).toHaveLength(1);
	});

	it("needs an objective and starts only once", async () => {
		const { state, run } = setup(true);
		expect(await run({ op: "start" })).toMatch(/needs the objective/);
		expect(state.goal).toBeNull();
		await run({ op: "start", objective: "Build it" });
		expect(await run({ op: "start", objective: "Other" })).toMatch(
			/already active/,
		);
	});

	it("is refused where the goal is fixed", async () => {
		const { state, run } = setup(false);
		expect(await run({ op: "start", objective: "Build it" })).toMatch(
			/cannot be started/,
		);
		expect(state.goal).toBeNull();
	});

	it("completes a started goal with evidence", async () => {
		const { state, run } = setup(true);
		await run({ op: "start", objective: "Build it" });
		await run({
			op: "update",
			status: "complete",
			evidence: [{ requirement: "Build it", proof: "ran build: ok" }],
		});
		expect(state.goal?.status).toBe("complete");
	});
});
