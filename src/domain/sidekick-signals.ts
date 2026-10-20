import { CODE_MODE_TOOL, codeModeResult } from "./code-mode";
import { leanToolNames } from "./harness-model-profile";
import type { SessionItem } from "./session-item";
import type { SubagentOutcome } from "./subagent";

/**
 * Hand-back signals for lead mode fusion (src/domain/sidekick.ts), a
 * deterministic stand-in for Devin Fusion's lightweight classifiers: after
 * each sidekick round the runtime compares what the round ran with the
 * round before and tells the lead when the sidekick looks stuck, so it can
 * re-brief more prescriptively or take over. With roleModels.writerEscalation
 * the next round restarts the sidekick on that model instead.
 */

export const SIDEKICK_SIGNAL_KINDS = [
	"same-check-failed",
	"same-error",
	"no-file-change",
	"round-budget",
] as const;
export type SidekickSignalKind = (typeof SIDEKICK_SIGNAL_KINDS)[number];
export type SidekickSignal = {
	readonly kind: SidekickSignalKind;
	readonly detail: string;
};

/** What a round leaves for the next one to compare with. */
export type RoundEvidence = {
	/** Normalized commands that exited non-zero (a no-match grep or test excluded). */
	readonly failedChecks: readonly string[];
	/** Normalized error lines of those failures. */
	readonly errors: readonly string[];
};

/** An exploration round reads and reports; a build round changes files. */
export type SidekickRoundKind = "explore" | "build";

const MAX_KEPT = 8;
const COMMAND_TOOLS = new Set<string>([...leanToolNames(["command"]), "bash"]);
/** Exit 1 of these means "no match" or "differs", not a failed check. */
const PROBES = /^(grep|egrep|fgrep|rg|diff|cmp|test|\[|which|pgrep|command)$/;
const ERROR_LINE =
	/error|fail|exception|traceback|assert|not found|undefined|cannot|refused|denied|panic|segmentation/i;

const normalizeCommand = (command: string) =>
	command.replaceAll(/\s+/g, " ").trim().slice(0, 200);

/** An error line comparable across runs: numbers, hashes and temp names masked. */
function normalizeError(line: string) {
	return line
		.replaceAll(/\b[0-9a-f]{7,64}\b/gi, "#")
		.replaceAll(/\d+/g, "#")
		.replaceAll(/\s+/g, " ")
		.trim()
		.slice(0, 160);
}

function errorLine(output: string) {
	const lines = output
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	const line =
		[...lines].reverse().find((entry) => ERROR_LINE.test(entry)) ??
		lines.at(-1);
	return line ? normalizeError(line) : "";
}

function parsedJson(text: string | undefined): Record<string, unknown> | null {
	if (!text) return null;
	try {
		const value = JSON.parse(text);
		return value && typeof value === "object" ? value : null;
	} catch {
		return null;
	}
}

/** Exit code and output of a command tool's result, in the shapes our tools return. */
function commandResult(
	output: unknown,
): { exitCode: number; output: string } | null {
	if (output && typeof output === "object") {
		const record = output as Record<string, unknown>;
		if (typeof record.exitCode === "number")
			return {
				exitCode: record.exitCode,
				output: String(record.output ?? record.stdout ?? ""),
			};
		return null;
	}
	if (typeof output !== "string") return null;
	const json = parsedJson(output);
	if (json) return commandResult(json);
	// A finished background job: `exited: {"exitCode": N, "stdout": ...}`.
	const exited = /^exited: (\{[\s\S]*?\})\s*(?:\noutput |$)/.exec(output);
	if (exited) {
		const record = parsedJson(exited[1]);
		if (record && typeof record.exitCode === "number")
			return {
				exitCode: record.exitCode,
				output: `${record.stdout ?? ""}\n${record.stderr ?? ""}`,
			};
	}
	// A foreground command: its output, then `exit N`.
	const plain = /\n?exit (\d+)\s*$/.exec(output);
	if (plain)
		return {
			exitCode: Number(plain[1]),
			output: output.slice(0, plain.index),
		};
	return null;
}

function commandOf(input: unknown): string {
	const record =
		typeof input === "string"
			? parsedJson(input)
			: input && typeof input === "object"
				? (input as Record<string, unknown>)
				: null;
	const command = record?.command ?? record?.cmd;
	return typeof command === "string" ? command : "";
}

function isFailure(command: string, exitCode: number) {
	if (!exitCode) return false;
	const first = command.trim().split(/\s+/)[0] ?? "";
	return !(exitCode === 1 && PROBES.test(first));
}

/** The failed commands of a round's items (code mode's inner calls included). */
export function roundEvidence(items: readonly SessionItem[]): RoundEvidence {
	const failures: { command: string; error: string }[] = [];
	const add = (command: string, result: ReturnType<typeof commandResult>) => {
		if (!command || !result || !isFailure(command, result.exitCode)) return;
		failures.push({
			command: normalizeCommand(command),
			error: errorLine(result.output),
		});
	};
	for (const item of items) {
		if (item.kind === "commandExecution" && item.exitCode !== null)
			add(item.command, {
				exitCode: item.exitCode,
				output: item.output ?? "",
			});
		if (item.kind !== "dynamicToolCall") continue;
		if (COMMAND_TOOLS.has(item.tool))
			add(commandOf(item.input), commandResult(item.output));
		if (item.tool === CODE_MODE_TOOL)
			for (const call of codeModeResult(item)?.calls ?? [])
				if (call && COMMAND_TOOLS.has(String(call.tool)))
					add(commandOf(call.input), commandResult(call.output));
	}
	const unique = (values: string[]) =>
		[...new Set(values.filter(Boolean))].slice(-MAX_KEPT);
	return {
		failedChecks: unique(failures.map((failure) => failure.command)),
		errors: unique(failures.map((failure) => failure.error)),
	};
}

/**
 * A round's items in its session's history: everything after the message
 * that started round `round` (the first round is the whole history).
 */
export function sidekickRoundItems(
	items: readonly SessionItem[],
	round: number,
): readonly SessionItem[] {
	if (round <= 1) return items;
	const start = new RegExp(`(^|\\n)Round ${round}[/ ]`);
	for (let index = items.length - 1; index >= 0; index--) {
		const item = items[index];
		if (item?.kind === "userMessage" && start.test(item.text))
			return items.slice(index + 1);
	}
	return items;
}

/** The signals of a round that just ended (compared with the round before it). */
export function sidekickSignals(input: {
	readonly kind: SidekickRoundKind;
	readonly outcome: SubagentOutcome;
	readonly patchFiles: number;
	readonly evidence: RoundEvidence;
	readonly previous?: RoundEvidence;
	/** Rounds the lead may still start in this turn. */
	readonly roundsLeft: number;
}): SidekickSignal[] {
	const signals: SidekickSignal[] = [];
	const previous = input.previous;
	const again = previous
		? input.evidence.failedChecks.filter((check) =>
				previous.failedChecks.includes(check),
			)
		: [];
	if (again.length)
		signals.push({ kind: "same-check-failed", detail: again[0] as string });
	const repeated = previous
		? input.evidence.errors.filter((error) => previous.errors.includes(error))
		: [];
	if (repeated.length && !again.length)
		signals.push({ kind: "same-error", detail: repeated[0] as string });
	if (input.kind === "build" && input.patchFiles === 0)
		signals.push({
			kind: "no-file-change",
			detail: "its build round changed no files",
		});
	if (input.outcome === "budget exhausted" || input.roundsLeft <= 0)
		signals.push({
			kind: "round-budget",
			detail:
				input.outcome === "budget exhausted"
					? "the round hit its budget"
					: "no rounds are left this turn",
		});
	return signals;
}

const REASON: Record<SidekickSignalKind, (detail: string) => string> = {
	"same-check-failed": (detail) =>
		`it failed the same check as last round (\`${detail}\`)`,
	"same-error": (detail) => `it hit the same error again (${detail})`,
	"no-file-change": () => "its build round changed no files",
	"round-budget": (detail) => detail,
};

/** Why the signals say the sidekick is stuck, as one clause. */
export function sidekickStuckReasons(signals: readonly SidekickSignal[]) {
	return signals.map((signal) => REASON[signal.kind](signal.detail)).join("; ");
}

/** The notice the lead's next request carries after a round with signals. */
export function sidekickStuckNotice(input: {
	readonly label: string;
	readonly signals: readonly SidekickSignal[];
	/** Set when its next round restarts on roleModels.writerEscalation. */
	readonly escalation?: string;
}) {
	if (!input.signals.length) return "";
	const reasons = sidekickStuckReasons(input.signals);
	return `Runtime notice: sidekick ${input.label} looks stuck because ${reasons}. Re-brief it more prescriptively (the exact change, file and line, and the command that must pass), or take over and do it yourself.${input.escalation ? ` If you send it another round, the runtime restarts it on ${input.escalation} with a handover of its last report (a model switch at a fresh context).` : ""}`;
}

/** Whether a round's signals call for the escalation model at the next round. */
export function warrantsEscalation(signals: readonly SidekickSignal[]) {
	return signals.some(
		(signal) =>
			signal.kind === "same-check-failed" ||
			signal.kind === "same-error" ||
			signal.kind === "no-file-change",
	);
}
