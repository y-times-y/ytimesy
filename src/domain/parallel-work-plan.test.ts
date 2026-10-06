import { expect, it } from "vitest";
import { scheduleParallelWork } from "./parallel-work-plan";

const task = (
	id: string,
	seconds: number,
	dependsOn: string[] = [],
	owns = [id],
) => ({ id, objective: id, estimatedSeconds: seconds, dependsOn, owns });

it("prioritizes the critical path and starts dependents as individual prerequisites finish", () => {
	const result = scheduleParallelWork(
		{
			tasks: [
				task("short", 1, [], ["short.ts"]),
				task("long", 8),
				task("follow", 8, ["short"], ["short.ts"]),
			],
		},
		2,
	);
	expect(result.schedule.map(({ id, start }) => [id, start])).toEqual([
		["short", 0],
		["long", 0],
		["follow", 1],
	]);
	expect(result.estimatedCompletionSeconds).toBe(9);
});

it("rejects cycles, unknown or duplicate IDs, and simultaneous overlapping writes", () => {
	expect(() =>
		scheduleParallelWork(
			{ tasks: [task("a", 1, ["b"]), task("b", 1, ["a"])] },
			2,
		),
	).toThrow("cycle");
	expect(() =>
		scheduleParallelWork({ tasks: [task("a", 1, ["missing"])] }, 2),
	).toThrow("Unknown");
	expect(() =>
		scheduleParallelWork({ tasks: [task("a", 1), task("a", 1)] }, 2),
	).toThrow("unique");
	expect(() =>
		scheduleParallelWork(
			{
				tasks: [task("a", 1, [], ["src/"]), task("b", 1, [], ["src/file.ts"])],
			},
			2,
		),
	).toThrow("overlaps");
});

it("marks multi-prerequisite joins instead of pretending one stacked branch includes every prerequisite", () => {
	const result = scheduleParallelWork(
		{ tasks: [task("a", 1), task("b", 2), task("join", 1, ["a", "b"])] },
		2,
	);
	expect(result.requiredJoins).toEqual(["join"]);
	expect(result.schedule.at(-1)).toMatchObject({ id: "join", start: 2 });
});
