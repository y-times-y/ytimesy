import { stripAnsi } from "./command-output-tone";
import type { EnvironmentCommandOutcome } from "./environment-detection";
import { redactSecrets } from "./redact-secrets";

/** Lines of a running command's output kept for the live view. */
export const BUILD_OUTPUT_LINES = 8;
const LINE_CHARACTERS = 240;

export type EnvironmentBuildStepState =
	| "running"
	| "done"
	| "failed"
	| "skipped";

export type EnvironmentBuildStepView = {
	readonly key: string;
	readonly label: string;
	readonly command: string | null;
	readonly state: EnvironmentBuildStepState;
	readonly exitCode: number | null;
	readonly output: string | null;
	/** Why it was skipped or what it noted ("dependencies unchanged"). */
	readonly note: string | null;
	readonly startedAt: string;
	readonly completedAt: string | null;
};

export type EnvironmentBuildFailure = EnvironmentCommandOutcome & {
	/** The step's label ("Installing dependencies"). */
	readonly step: string | null;
};

export type EnvironmentBuildView = {
	readonly id: string;
	readonly status: "running" | "ready" | "failed";
	/** A later build: the project keeps its previous environment meanwhile. */
	readonly rebuild: boolean;
	readonly startedAt: string;
	readonly completedAt: string | null;
	readonly errorMessage: string | null;
	readonly failure: EnvironmentBuildFailure | null;
};

export type EnvironmentBuildProgress = {
	readonly build: EnvironmentBuildView | null;
	readonly steps: readonly EnvironmentBuildStepView[];
};

/**
 * The last lines of command output as a person reads them: ANSI codes and
 * carriage-return redraws gone, build-secret values and token-shaped strings
 * redacted, each line bounded.
 */
export function buildOutputTail(
	text: string,
	secretValues: readonly string[] = [],
	lines = BUILD_OUTPUT_LINES,
) {
	let clean = stripAnsi(text);
	for (const value of secretValues)
		if (value.length >= 4) clean = clean.split(value).join("[redacted]");
	const shown = clean
		.split("\n")
		.map((line) => {
			const redraw = line.replace(/\r+$/, "");
			return redraw.slice(redraw.lastIndexOf("\r") + 1).trimEnd();
		})
		.filter((line) => line.trim().length > 0)
		.slice(-lines)
		.map((line) =>
			line.length > LINE_CHARACTERS
				? `${line.slice(0, LINE_CHARACTERS - 1)}…`
				: line,
		);
	return redactSecrets(shown.join("\n"), 4000);
}

/** One line for status bars and Settings: the failing command and its exit code. */
export function environmentFailureSummary(
	failure: Pick<EnvironmentBuildFailure, "command" | "exitCode" | "step">,
) {
	const command =
		failure.command.length > 120
			? `${failure.command.slice(0, 119)}…`
			: failure.command;
	return `${failure.step ? `${failure.step}: ` : ""}${command} failed (exit ${failure.exitCode})`;
}

/** Seconds a step took (or has taken so far), for "12s" / "2m 05s". */
export function stepDuration(
	step: Pick<EnvironmentBuildStepView, "startedAt" | "completedAt">,
	now: number,
) {
	const start = Date.parse(step.startedAt);
	const end = step.completedAt ? Date.parse(step.completedAt) : now;
	if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
	const seconds = Math.max(0, Math.round((end - start) / 1000));
	return seconds < 60
		? `${seconds}s`
		: `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/** Whether the live view should keep reading: a build is still running. */
export function buildProgressIsLive(progress: EnvironmentBuildProgress | null) {
	return progress?.build?.status === "running";
}

/**
 * A setup command that failed, with what the person needs to fix it. The
 * output is already a redacted tail (buildOutputTail).
 */
export class EnvironmentCommandFailure extends Error {
	readonly failure: EnvironmentBuildFailure;
	constructor(failure: EnvironmentBuildFailure) {
		super(environmentFailureSummary(failure));
		this.name = "EnvironmentCommandFailure";
		this.failure = failure;
	}
}
