import { expect, it } from "vitest";
import {
	BUILD_OUTPUT_LINES,
	buildOutputTail,
	EnvironmentCommandFailure,
	environmentFailureSummary,
	stepDuration,
} from "./environment-build-progress";

it("keeps the last lines of output without ANSI codes or redraws", () => {
	const output = [
		...Array.from({ length: 20 }, (_, index) => `line ${index}`),
		"\u001b[32mProgress: resolved 10\rProgress: resolved 99\u001b[0m",
		"",
	].join("\n");
	const tail = buildOutputTail(output);
	const lines = tail.split("\n");
	expect(lines).toHaveLength(BUILD_OUTPUT_LINES);
	expect(lines.at(-1)).toBe("Progress: resolved 99");
	expect(tail).not.toContain("\u001b");
	expect(lines[0]).toBe("line 13");
});

it("redacts build secret values and token-shaped strings", () => {
	const tail = buildOutputTail(
		"npm ERR! 401 for token npm_S3cretValue\nusing ghp_abcdefghijklmnop1234",
		["npm_S3cretValue"],
	);
	expect(tail).not.toContain("S3cretValue");
	expect(tail).not.toContain("ghp_abcdefghijklmnop1234");
	expect(tail).toContain("[redacted]");
});

it("bounds long lines", () => {
	const tail = buildOutputTail("x".repeat(1000));
	expect(tail.length).toBeLessThanOrEqual(240);
});

it("summarizes a failure by its step, command and exit code", () => {
	const failure = {
		step: "Installing dependencies",
		command: "pnpm install --frozen-lockfile",
		exitCode: 1,
		output: "ERR_PNPM_OUTDATED_LOCKFILE",
	};
	expect(environmentFailureSummary(failure)).toBe(
		"Installing dependencies: pnpm install --frozen-lockfile failed (exit 1)",
	);
	const error = new EnvironmentCommandFailure(failure);
	expect(error.message).toBe(environmentFailureSummary(failure));
	expect(error.failure.output).toBe("ERR_PNPM_OUTDATED_LOCKFILE");
});

it("shows how long a step took, or has taken so far", () => {
	const startedAt = "2026-11-01T10:00:00.000Z";
	expect(
		stepDuration(
			{ startedAt, completedAt: "2026-11-01T10:00:12.400Z" },
			Date.now(),
		),
	).toBe("12s");
	expect(
		stepDuration(
			{ startedAt, completedAt: null },
			Date.parse(startedAt) + 125_000,
		),
	).toBe("2m 05s");
});
