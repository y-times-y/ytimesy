/**
 * A checker's structured answer and how it is read from its report (the
 * review loop, the attempt loop, the builder's checker subagent and the
 * checker detection test all parse with this).
 */

export const ATTEMPT_VERDICTS = ["pass", "fail", "unsure"] as const;
export type AttemptVerdictKind = (typeof ATTEMPT_VERDICTS)[number];

/** A test or probe the checker wrote and ran (name = what it checks). */
export type CheckerTest = {
	readonly name: string;
	readonly passed: boolean;
	readonly evidence?: string;
	/** One command that runs it (absolute paths), so the builder can reproduce it. */
	readonly command?: string;
	/** The output lines that show its result. */
	readonly output?: string;
	/** checkerMode=pair: which session of the pair ran its command (src/domain/checker-pair.ts). */
	readonly ranBy?: "worker" | "judge";
};

/** The checker's structured answer, normalized. */
export type CheckerVerdict = {
	readonly verdict: AttemptVerdictKind;
	readonly failures: readonly string[];
	readonly tests: readonly CheckerTest[];
	/** Where its acceptance tests (and run.sh) are, as it reported them. */
	readonly testsPath: string | null;
	readonly notes: string;
	/** False when the report held no verdict JSON (counted as unsure). */
	readonly parsed: boolean;
	/** The verdict JSON was cut off (a timed-out answer); a pass from it counts as unsure. */
	readonly truncated?: boolean;
};

/** Every balanced top-level {...} in a text, last first (strings respected). */
export function jsonObjects(text: string): string[] {
	const found: string[] = [];
	for (let end = text.lastIndexOf("}"); end >= 0; ) {
		let depth = 0;
		let start = -1;
		let inString = false;
		// Scan backwards for the matching opening brace.
		for (let index = end; index >= 0; index--) {
			const char = text[index];
			if (inString) {
				if (char === '"') {
					let slashes = 0;
					for (let back = index - 1; back >= 0 && text[back] === "\\"; back--)
						slashes++;
					if (slashes % 2 === 0) inString = false;
				}
				continue;
			}
			if (char === '"') inString = true;
			else if (char === "}") depth++;
			else if (char === "{") {
				depth--;
				if (depth === 0) {
					start = index;
					break;
				}
			}
		}
		if (start < 0) break;
		found.push(text.slice(start, end + 1));
		end = text.lastIndexOf("}", start - 1);
	}
	return found;
}

const text = (value: unknown, max: number) =>
	typeof value === "string" ? value.trim().slice(0, max) : "";

/**
 * A verdict object cut off mid-answer (a checker stopped at its time limit):
 * from the last `{"verdict":` to the last complete member or element, with
 * the open brackets closed. Null when there is none or nothing complete.
 */
export function truncatedVerdictJson(report: string): string | null {
	let start = -1;
	for (const match of report.matchAll(/\{\s*"verdict"\s*:/g))
		start = match.index ?? start;
	if (start < 0) return null;
	const stack: string[] = [];
	let inString = false;
	let escaped = false;
	let safeEnd = -1;
	let safeStack: string[] = [];
	for (let index = start; index < report.length; index++) {
		const char = report[index];
		if (inString) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') inString = true;
		else if (char === "{" || char === "[") stack.push(char);
		else if (char === "}" || char === "]") {
			stack.pop();
			if (!stack.length) return report.slice(start, index + 1);
			safeEnd = index + 1;
			safeStack = [...stack];
		} else if (char === ",") {
			safeEnd = index;
			safeStack = [...stack];
		}
	}
	if (safeEnd < 0) return null;
	return `${report.slice(start, safeEnd)}${safeStack
		.reverse()
		.map((open) => (open === "{" ? "}" : "]"))
		.join("")}`;
}

/** The verdict objects in a report, last first, then a cut-off one when no complete one parses. */
export function verdictRecords(
	report: string,
): { record: Record<string, unknown>; truncated: boolean }[] {
	const found: { record: Record<string, unknown>; truncated: boolean }[] = [];
	for (const candidate of jsonObjects(report)) {
		try {
			const value = JSON.parse(candidate);
			if (
				value &&
				typeof value === "object" &&
				(ATTEMPT_VERDICTS as readonly unknown[]).includes(value.verdict)
			)
				found.push({ record: value, truncated: false });
		} catch {}
	}
	if (found.length) return found;
	const cut = truncatedVerdictJson(report);
	if (!cut) return [];
	try {
		const value = JSON.parse(cut);
		if (
			value &&
			typeof value === "object" &&
			(ATTEMPT_VERDICTS as readonly unknown[]).includes(value.verdict)
		)
			return [{ record: value, truncated: true }];
	} catch {}
	return [];
}

/**
 * The verdict in a checker's report: the last JSON object with a valid
 * `verdict` (fenced or not), else one cut off mid-answer. A "pass" whose own
 * tests failed, or that was cut off, is not trusted (unsure). No JSON is an
 * unsure verdict, never a pass.
 */
export function parseCheckerVerdict(report: string): CheckerVerdict {
	const [found] = verdictRecords(report);
	if (!found)
		return {
			verdict: "unsure",
			failures: [NO_VERDICT_FAILURE],
			tests: [],
			testsPath: null,
			notes: report.trim().slice(-800),
			parsed: false,
		};
	const { record, truncated } = found;
	const verdict = record.verdict as AttemptVerdictKind;
	const tests: CheckerTest[] = Array.isArray(record.tests)
		? record.tests.slice(0, 100).flatMap((entry) => {
				if (!entry || typeof entry !== "object") return [];
				const test = entry as Record<string, unknown>;
				const name = text(test.name, 200) || text(test.checks, 200);
				const result = text(test.result, 20).toLowerCase();
				const passed =
					typeof test.passed === "boolean"
						? test.passed
						: result === "pass" || result === "passed"
							? true
							: result === "fail" || result === "failed"
								? false
								: null;
				if (!name || passed === null) return [];
				const evidence = text(test.evidence, 600);
				const command = text(test.command, 500);
				const output = text(test.output, 800);
				return [
					{
						name,
						passed,
						...(evidence ? { evidence } : {}),
						...(command ? { command } : {}),
						...(output ? { output } : {}),
					},
				];
			})
		: [];
	const listed = Array.isArray(record.failures)
		? record.failures
				.map((failure) =>
					typeof failure === "string"
						? text(failure, 600)
						: failure && typeof failure === "object"
							? text(JSON.stringify(failure), 600)
							: "",
				)
				.filter(Boolean)
		: [];
	const failures = (
		listed.length
			? listed
			: tests
					.filter((test) => !test.passed)
					.map((test) => {
						const evidence = test.evidence ?? test.output;
						return evidence ? `${test.name}: ${evidence}` : test.name;
					})
	).slice(0, 20);
	const testsPath = text(record.testsPath, 500);
	const anyFailed = tests.some((test) => !test.passed);
	const notes = text(record.notes, 2000);
	return {
		verdict:
			verdict === "pass" && (anyFailed || listed.length || truncated)
				? "unsure"
				: verdict,
		failures,
		tests,
		testsPath: testsPath.startsWith("/") ? testsPath : null,
		notes: truncated
			? `(The answer was cut off before it finished.)${notes ? ` ${notes}` : ""}`
			: notes,
		parsed: true,
		...(truncated ? { truncated: true } : {}),
	};
}

/** The note an untested pass gets. */
export const UNTESTED_PASS_NOTE =
	"(Said pass without running a new test of its own; counted as unsure.)";

/** The failure a report without verdict JSON gets (not a finding about the work). */
export const NO_VERDICT_FAILURE = "The checker's report held no verdict JSON.";
