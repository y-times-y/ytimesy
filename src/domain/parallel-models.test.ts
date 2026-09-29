import { expect, it } from "vitest";
import {
	availableModelRunCounts,
	expandModelRuns,
	parallelAttemptModelIds,
	selectModelRun,
	setModelRunCount,
} from "./parallel-models";

it("selects models and caps independent attempts at five", () => {
	const first = [{ modelId: "a", count: 2 }];
	const both = selectModelRun(first, "b");
	expect(expandModelRuns(both)).toEqual(["a", "a", "b"]);
	expect(expandModelRuns(setModelRunCount(both, "b", 3))).toHaveLength(5);
	expect(setModelRunCount(both, "b", 4)).toEqual(both);
	expect(selectModelRun([{ modelId: "a", count: 5 }], "b")).toEqual([
		{ modelId: "a", count: 5 },
	]);
	expect(selectModelRun([{ modelId: "a", count: 1 }], "a")).toHaveLength(1);
	expect(availableModelRunCounts([{ modelId: "a", count: 2 }], "a")).toEqual([
		2, 3, 4, 5,
	]);
});

it("rejects malformed or oversized attempt assignments", () => {
	expect(parallelAttemptModelIds.safeParse(["a", "b"]).success).toBe(true);
	expect(parallelAttemptModelIds.safeParse(["a"]).success).toBe(false);
	expect(parallelAttemptModelIds.safeParse(Array(6).fill("a")).success).toBe(
		false,
	);
});
