import { expect, it } from "vitest";
import {
	builderWorkState,
	builderWorkUpdate,
} from "#/domain/builder-work-state";
import { withBuilderWorkState } from "./builder-work-state";

it("rehydrates after compaction without changing opaque history or duplicating current state", () => {
	const state = builderWorkState.parse({
		revision: 1,
		objective: "Fix parser",
		steps: [{ step: "Verify", status: "in_progress" }],
		evidence: ["output-ref"],
		remaining: ["command-id still running"],
	});
	const history = [
		{ role: "assistant" as const, content: "opaque checkpoint" },
	];
	const restored = withBuilderWorkState(history, state);
	expect(history).toHaveLength(1);
	expect(restored[0]).toBe(history[0]);
	expect(JSON.stringify(restored)).toContain("command-id still running");
	expect(withBuilderWorkState(restored, state)).toBe(restored);
	expect(withBuilderWorkState(history, null)).toBe(history);
});

it("rejects multiple current steps", () => {
	expect(
		builderWorkUpdate.safeParse({
			expectedRevision: 0,
			objective: "Task",
			steps: [
				{ step: "A", status: "in_progress" },
				{ step: "B", status: "in_progress" },
			],
			evidence: [],
			remaining: [],
		}).success,
	).toBe(false);
});
