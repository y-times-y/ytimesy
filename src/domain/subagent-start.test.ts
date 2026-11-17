import { describe, expect, it } from "vitest";
import { failureMessage, plainFailureText } from "./failure-message";
import {
	couldntStartMessage,
	isTransientStartFailure,
	startStageError,
} from "./subagent-start";

describe("subagent start classification", () => {
	it("retries transient failures", () => {
		for (const text of [
			"ECONNRESET",
			"Freestyle API 503",
			"resource busy",
			"The model request failed and the provider didn't say why",
			"VM copy refused",
			"lease race: try again",
			"request timed out",
			"",
		])
			expect(isTransientStartFailure(text), text).toBe(true);
	});

	it("never retries permanent ones", () => {
		for (const text of [
			"Too many live helpers",
			"The subagent is already running or no longer available.",
			"Your cloud execution allowance is exhausted",
			"A brief is required.",
			"token budget too small",
		])
			expect(isTransientStartFailure(text), text).toBe(false);
	});

	it("keeps the stage and the original message of an Effect-wrapped failure", () => {
		const wrapped = {
			message: "An unknown error occurred in Effect.tryPromise",
			error: new Error("socket hang up"),
		};
		const error = startStageError("fork", wrapped);
		expect(error.stage).toBe("fork");
		expect(error.causeMessage).toBe("socket hang up");
		expect(error.retryable).toBe(true);
	});

	it("words the final message without internal text", () => {
		const text = couldntStartMessage(
			"fork",
			"An unknown error occurred in Effect.tryPromise",
			3,
		);
		expect(text).toBe(
			"Couldn't start the helper (the machine copy was refused). I retried 3 times. Try again in a moment; nothing was changed.",
		);
		expect(text).not.toMatch(/Effect/);
	});
});

describe("generic boundary", () => {
	it("rewrites Effect's default text, with the stage when known", () => {
		const text = "An unknown error occurred in Effect.tryPromise";
		expect(plainFailureText(text)).toBe(
			"Something went wrong on our side. It's been logged; try again.",
		);
		expect(plainFailureText(text, "reserve")).toContain("(stage: reserve)");
		expect(plainFailureText("VM not found")).toBe("VM not found");
		expect(failureMessage({ message: text, stage: "fork" })).toContain(
			"stage: fork",
		);
		expect(failureMessage({ message: text })).not.toMatch(/Effect/);
	});
});
