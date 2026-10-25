import { type ToolSet, tool } from "ai";
import { z } from "zod";

/**
 * The requirement ledger (harness variant ledger=on, unattended runs): the
 * root builder records the request's requirements with the `requirements`
 * tool before it builds, each quoting the request, with the readings of an
 * ambiguous sentence and one shell command that proves it on the final
 * deliverable. When the builder finishes, the harness itself runs every
 * check in the sandbox and sends the builder back with the failures (or
 * with no ledger recorded), at most LEDGER_MAX_ROUNDS times. All text is
 * generic: it names no task, check or known failure.
 */

export const REQUIREMENTS_TOOL = "requirements";

/** Continuations (send-backs) per trial at most. */
export const LEDGER_MAX_ROUNDS = 2;
/** No checks and no continuation when less than this is left: the agent needs time to act. */
export const LEDGER_MIN_REMAINING_MS = 10 * 60_000;
/** One check command at most. */
export const LEDGER_CHECK_TIMEOUT_MS = 120_000;
/** All of one gate round's checks at most. */
export const LEDGER_GATE_TOTAL_MS = 8 * 60_000;
/** Requirements in one list at most. */
export const LEDGER_MAX_ITEMS = 40;
/** Characters of a failing check's output in the notice. */
const OUTPUT_TAIL_CHARACTERS = 1_200;
/** Characters of the whole notice at most. */
const NOTICE_CHARACTERS = 16_000;

/**
 * Finish continuations per trial at most when ledger=on and grind=on both
 * send the builder back: the ledger gate goes first, grind gets what is left.
 */
export const FINISH_CONTINUATIONS_MAX = 3;

const reading = z.object({
	reading: z.string().min(1).describe("One plausible interpretation"),
	satisfied: z
		.boolean()
		.describe("Whether the deliverable satisfies this reading"),
});

const requirement = z.object({
	id: z.string().min(1).max(40).describe("A short unique id, e.g. R1"),
	quote: z
		.string()
		.min(1)
		.describe("The exact words of the request this requirement comes from"),
	readings: z
		.array(reading)
		.min(2)
		.optional()
		.describe(
			"Only when the quoted words can be read more than one way: the plausible readings. Satisfy every reading that does not conflict with another.",
		),
	check: z
		.string()
		.min(1)
		.describe(
			"One shell command, run from the working directory on the final deliverable, that exits 0 only when the requirement holds",
		),
});

const requirementsInput = z.object({
	op: z
		.enum(["set", "get"])
		.describe("set replaces the whole list; get returns it"),
	requirements: z
		.array(requirement)
		.max(LEDGER_MAX_ITEMS)
		.optional()
		.describe("op set: the full list of the request's requirements"),
});

export type Requirement = z.infer<typeof requirement>;

/** One run of the checks as the trace records it. */
export type LedgerGateEntry = {
	readonly round: number;
	readonly at: string;
	readonly items: number;
	readonly failed: readonly string[];
	/** Checks the round's time cap left unrun (not counted as failures). */
	readonly unchecked: readonly string[];
	readonly seconds: number;
	/** true: a continuation follows. */
	readonly sentBack: boolean;
};

export type LedgerState = {
	items: Requirement[] | null;
	/** Every accepted set, for the trace. */
	sets: { at: string; items: number; replaced: number | null }[];
};

const normalize = (text: string) =>
	text.replace(/\s+/g, " ").trim().toLowerCase();

/** The builder's `requirements` tool over one trial's ledger. */
export function requirementsTool(input: {
	state: LedgerState;
	/** The user's request, to check the quotes against. */
	instruction: string;
	now: () => number;
	log: (line: string) => void;
}): ToolSet {
	const request = normalize(input.instruction);
	return {
		[REQUIREMENTS_TOOL]: tool({
			description:
				'Record the request\'s requirements (op "set", the full list; it replaces any earlier list) or read them back (op "get"). Each item quotes the exact words of the request it comes from, lists the plausible readings when those words are ambiguous, and gives one shell command that exits 0 only when the requirement holds on the final deliverable. The harness runs every check when you finish.',
			inputSchema: requirementsInput,
			execute: async (args) => {
				const { state } = input;
				if (args.op === "get")
					return state.items
						? JSON.stringify(state.items, null, 2)
						: "No requirements recorded yet.";
				const items = args.requirements ?? [];
				if (!items.length)
					return 'Nothing recorded: op "set" takes the full, non-empty list of requirements.';
				const ids = items.map((item) => item.id);
				const repeated = ids.filter((id, index) => ids.indexOf(id) !== index);
				if (repeated.length)
					return `Nothing recorded: ids must be unique (repeated: ${[...new Set(repeated)].join(", ")}).`;
				const replaced = state.items?.length ?? null;
				state.items = items;
				state.sets.push({
					at: new Date(input.now()).toISOString(),
					items: items.length,
					replaced,
				});
				input.log(
					`ledger set ${items.length} items${replaced === null ? "" : ` (replaced ${replaced})`}`,
				);
				const unquoted = items
					.filter((item) => !request.includes(normalize(item.quote)))
					.map((item) => item.id);
				const unsatisfied = items
					.filter(
						(item) =>
							item.readings && !item.readings.some((entry) => entry.satisfied),
					)
					.map((item) => item.id);
				return [
					`Recorded ${items.length} requirements${replaced === null ? "" : `, replacing the earlier ${replaced}`}. When you finish, the harness runs every check on the final result and sends you back if one fails.`,
					...(unquoted.length
						? [
								`Not found word for word in the request: ${unquoted.join(", ")}. Quote the request's exact words.`,
							]
						: []),
					...(unsatisfied.length
						? [
								`No reading marked satisfied: ${unsatisfied.join(", ")}. The deliverable should satisfy at least one, and every one that does not conflict with another.`,
							]
						: []),
				].join("\n");
			},
		}),
	};
}

/**
 * The note on the first user message: record the requirements before
 * building. Appended after the request, so the request stays intact.
 */
export const LEDGER_INSTRUCTION = [
	'Harness note: before you build, record this request\'s requirements with the requirements tool (op "set"). Give each one the exact words of the request it comes from as its quote.',
	"Where a sentence can be read more than one way, record the plausible readings and satisfy every reading that does not conflict with another.",
	"Give each requirement one shell command that checks it on the final result (exit 0 = it holds). Keep the list current as you learn more; when you finish, the harness runs every check and sends you back if one fails.",
].join(" ");

export function withLedgerInstruction(instruction: string) {
	return `${instruction}\n\n${LEDGER_INSTRUCTION}`;
}

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

const tail = (text: string, limit: number) =>
	text.length > limit ? `…${text.slice(-limit)}` : text;

type CheckResult = { exitCode: number; output: string };

/**
 * One gate check after a root builder finish. Runs every item's check (each
 * bounded, the round capped in total) and returns the notice for a
 * continuation, or null when every check passed, no round is left or too
 * little time remains. Checks still run (for the trace) once the rounds
 * are used up, while the time allows.
 */
export async function ledgerGate(input: {
	state: LedgerState;
	cwd: string;
	exec: (command: string, timeoutMs: number) => Promise<CheckResult>;
	/** Continuations already sent. */
	rounds: number;
	/** Check runs so far (this one's number is runs + 1). */
	runs: number;
	deadlineAtMs: number;
	now: () => number;
	signal?: AbortSignal;
	log: (line: string) => void;
}): Promise<{ notice: string | null; entry: LedgerGateEntry | null }> {
	const started = input.now();
	const remaining = input.deadlineAtMs - started;
	const round = input.runs + 1;
	if (remaining < LEDGER_MIN_REMAINING_MS) {
		input.log(
			`ledger gate skipped: ${Math.round(remaining / 60_000)} minutes left`,
		);
		return { notice: null, entry: null };
	}
	const canSend = input.rounds < LEDGER_MAX_ROUNDS;
	const items = input.state.items ?? [];
	const entry = (
		failed: string[],
		unchecked: string[],
		sentBack: boolean,
	): LedgerGateEntry => ({
		round,
		at: new Date(started).toISOString(),
		items: items.length,
		failed,
		unchecked,
		seconds: Math.round((input.now() - started) / 1000),
		sentBack,
	});
	if (!items.length) {
		input.log(`ledger gate round ${round}: no ledger recorded`);
		return {
			notice: canSend ? LEDGER_MISSING_NOTICE : null,
			entry: entry([], [], canSend),
		};
	}
	// Leave the agent time to act on what the checks find.
	const cap = Math.min(
		LEDGER_GATE_TOTAL_MS,
		remaining - LEDGER_MIN_REMAINING_MS / 2,
	);
	const failures: { item: Requirement; result: CheckResult }[] = [];
	const unchecked: string[] = [];
	for (const item of items) {
		const left = cap - (input.now() - started);
		if (left < 5_000 || input.signal?.aborted) {
			unchecked.push(item.id);
			continue;
		}
		const result = await input
			.exec(
				`cd ${quote(input.cwd)} && (\n${item.check}\n) 2>&1`,
				Math.min(LEDGER_CHECK_TIMEOUT_MS, left),
			)
			.then(
				(out) => out,
				(error: unknown) => ({
					exitCode: -1,
					output: error instanceof Error ? error.message : String(error),
				}),
			);
		if (result.exitCode !== 0) failures.push({ item, result });
	}
	const failed = failures.map(({ item }) => item.id);
	input.log(
		`ledger gate round ${round}: ${failed.length}/${items.length} failed${unchecked.length ? ` (${unchecked.length} unchecked: time cap)` : ""}${failed.length && !canSend ? " (no rounds left)" : ""}`,
	);
	const sentBack = canSend && failed.length > 0;
	return {
		notice: sentBack ? ledgerFailureNotice(failures, items.length) : null,
		entry: entry(failed, unchecked, sentBack),
	};
}

export const LEDGER_MISSING_NOTICE = [
	"Runtime notice, not a new user request. You finished without recording the request's requirements.",
	'Record them now with the requirements tool (op "set"): one item per requirement, quoting the request\'s exact words, with the readings of any ambiguous sentence and one shell command that checks it on the final result (exit 0 = it holds).',
	"Fix whatever a check shows, then finish again; the harness runs every check when you do.",
].join("\n");

export function ledgerFailureNotice(
	failures: readonly { item: Requirement; result: CheckResult }[],
	total: number,
): string {
	const head = `Runtime notice, not a new user request. The harness ran your requirement checks on the final result: ${failures.length} of ${total} failed.`;
	const foot = [
		"Fix the deliverable so each failing requirement holds. If a check itself is wrong (it tests something the request does not ask for, or tests it the wrong way), correct it with the requirements tool and keep its quote; do not weaken a check just to make it pass.",
		"Then finish again; the checks run again when you do.",
	].join("\n");
	const blocks: string[] = [];
	let length = head.length + foot.length;
	for (const { item, result } of failures) {
		const block = [
			`- ${item.id}: "${item.quote}"`,
			`  check: ${item.check}`,
			`  exit code: ${result.exitCode}`,
			`  output (tail):\n${
				tail(result.output.trimEnd(), OUTPUT_TAIL_CHARACTERS)
					.split("\n")
					.map((line) => `    ${line}`)
					.join("\n") || "    (none)"
			}`,
		].join("\n");
		if (length + block.length > NOTICE_CHARACTERS) {
			blocks.push(
				`- ${failures.length - blocks.length} more failed; call the requirements tool (op "get") and run their checks.`,
			);
			break;
		}
		blocks.push(block);
		length += block.length;
	}
	return [head, ...blocks, foot].join("\n");
}
