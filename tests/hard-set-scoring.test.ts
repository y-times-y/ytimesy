import { describe, expect, it } from "vitest";
import {
	infraFailure,
	isScored,
	type ScoredRecord,
} from "../scripts/hard-set/scoring";

const record = (overrides: Partial<ScoredRecord> = {}): ScoredRecord => ({
	status: "final",
	state: "completed",
	usageLimit: null,
	reward: 0,
	agentBudgetSec: 420,
	agentRequestedSec: 420,
	errors: [],
	...overrides,
});

describe("hard-set scoring", () => {
	it("scores a model's own fail", () => {
		expect(isScored(record())).toBe(true);
		expect(isScored(record({ reward: 1 }))).toBe(true);
		// A failed turn without an infrastructure cause is still the model's fail.
		const modelFail = record({
			state: "failed",
			errors: ["Cancelled: agent time limit (420s)."],
		});
		expect(infraFailure(modelFail)).toBeNull();
		expect(isScored(modelFail)).toBe(true);
	});

	it.each([
		"Run stopped. Turn heartbeat or coordination service became unavailable. Inspect any in-flight command before continuing.",
		"The conversation coordinator could not confirm this turn's ownership or completion. Work is preserved; inspect the latest task state before continuing. [debug Error: The conversation is already running or was stopped.]",
		"Selected subscription model is unavailable.",
		"Run stopped. Conversation coordination lease was lost. Inspect any in-flight command before continuing.",
		"Your ChatGPT plan's Codex usage limit is used up.",
	])("does not score a turn that failed of infrastructure: %s", (error) => {
		const failed = record({ state: "failed", errors: [error] });
		expect(infraFailure(failed)).toBe(error);
		expect(isScored(failed)).toBe(false);
	});

	it("only blames infrastructure when the turn actually failed", () => {
		const recovered = record({
			state: "completed",
			errors: [
				"Run stopped. Turn heartbeat or coordination service became unavailable.",
			],
		});
		expect(infraFailure(recovered)).toBeNull();
		expect(isScored(recovered)).toBe(true);
	});

	it("does not score usage limits, skips, short budgets or ungraded runs", () => {
		expect(isScored(record({ usageLimit: "Codex usage limit reached" }))).toBe(
			false,
		);
		expect(infraFailure(record({ usageLimit: "limit" }))).toBe("limit");
		expect(isScored(record({ state: "skipped" }))).toBe(false);
		expect(isScored(record({ agentBudgetSec: 200 }))).toBe(false);
		expect(isScored(record({ status: "grading" }))).toBe(false);
		expect(isScored(record({ reward: null }))).toBe(false);
	});
});
