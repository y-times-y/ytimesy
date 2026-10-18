// Blind grading and scoring for the checker detection test
// (docs/checker-detect.md). The checker never grades itself: a separate
// grader (a model in its own session, or a person with the sheet) compares the
// hidden grader's failure output with the checker's findings.
import type { AttemptVerdictKind } from "../../src/domain/attempt-loop";
import { rank, type SampleKind } from "./select";

/** Grader output files, by name, as saved with the trial (verifier/). */
export type GraderFiles = Readonly<Record<string, string>>;

const clipTail = (text: string, max: number) =>
	text.length > max ? `...${text.slice(-max)}` : text;
const clipHead = (text: string, max: number) =>
	text.length > max ? `${text.slice(0, max)}...` : text;

/**
 * The hidden grader's failure output, condensed: failed tests from ctrf.json
 * (name and message), other detail files (head), then the test output's tail.
 */
export function failureEvidence(files: GraderFiles, max = 12_000) {
	const parts: string[] = [];
	const ctrf = files["ctrf.json"];
	if (ctrf)
		try {
			const tests = (
				JSON.parse(ctrf) as {
					results?: {
						tests?: { name?: string; status?: string; message?: string }[];
						summary?: Record<string, unknown>;
					};
				}
			).results;
			const failed = (tests?.tests ?? []).filter(
				(test) => test.status !== "passed" && test.status !== "skipped",
			);
			parts.push(
				`Test summary: ${JSON.stringify(tests?.summary ?? {})}`,
				...failed
					.slice(0, 30)
					.map(
						(test) =>
							`FAILED ${test.name ?? "?"}: ${clipHead(test.message ?? "", 1200)}`,
					),
			);
		} catch {
			parts.push(`ctrf.json (unparsed): ${clipHead(ctrf, 2000)}`);
		}
	for (const [name, text] of Object.entries(files).sort(([a], [b]) =>
		a.localeCompare(b),
	)) {
		if (["ctrf.json", "test-stdout.txt"].includes(name)) continue;
		if (/^reward\.(txt|json)$/.test(name)) {
			parts.push(`${name}: ${clipHead(text.trim(), 200)}`);
			continue;
		}
		parts.push(`${name}:\n${clipHead(text, 3000)}`);
	}
	const stdout = files["test-stdout.txt"];
	if (stdout?.trim())
		parts.push(`test-stdout.txt (tail):\n${clipTail(stdout, 6000)}`);
	return clipHead(parts.join("\n\n"), max);
}

export type CheckerFindings = {
	readonly verdict: AttemptVerdictKind | null;
	readonly failures: readonly string[];
	readonly unmetRequirements: readonly string[];
	readonly notes: string;
};

/** Anonymous id for a sample on the grading sheet (the grader never sees task or trial names). */
export const blindId = (sampleId: string) => `S-${rank(sampleId).slice(0, 8)}`;

export const GRADE_LABELS = ["named_cause", "other"] as const;
export type GradeLabel = (typeof GRADE_LABELS)[number];

export type Grade = {
	readonly label: GradeLabel;
	/** For "other": whether what it flagged is a real defect, from the evidence. */
	readonly otherReal: boolean | null;
	/** The grader's one-line statement of the hidden failure's cause. */
	readonly cause: string;
	readonly reason: string;
};

export const GRADE_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: ["cause", "label", "otherReal", "reason"],
	properties: {
		cause: { type: "string" },
		label: { type: "string", enum: [...GRADE_LABELS] },
		otherReal: { type: ["boolean", "null"] },
		reason: { type: "string" },
	},
} as const;

/** The grader's prompt for one failing sample (the checker's verdict is fail or unsure). */
export function gradingPrompt(input: {
	readonly instruction: string;
	readonly evidence: string;
	readonly findings: CheckerFindings;
}) {
	const listed = [
		...input.findings.failures,
		...input.findings.unmetRequirements.filter(
			(entry) => !input.findings.failures.includes(entry),
		),
	];
	return [
		"You grade a reviewer. A task's hidden tests failed the delivered work. Separately, a reviewer who could not see the tests inspected the same work and reported findings. Decide whether the reviewer named the actual cause of the hidden failure.",
		"",
		"<task>",
		clipHead(input.instruction, 6000),
		"</task>",
		"",
		"<hidden_test_failure>",
		input.evidence,
		"</hidden_test_failure>",
		"",
		"<reviewer_findings>",
		...(listed.length
			? listed.map((finding, index) => `${index + 1}. ${finding}`)
			: ["(no specific finding)"]),
		...(input.findings.notes
			? [`Notes: ${clipHead(input.findings.notes, 1500)}`]
			: []),
		"</reviewer_findings>",
		"",
		"First state the cause of the hidden failure in one line, from the test output. Then label:",
		'- "named_cause": a finding identifies that cause (the same defect or requirement, even in other words, specific enough that fixing it would address at least one of the failing checks). A vague finding ("may not meet the spec") does not count.',
		'- "other": no finding identifies it. Then set otherReal: true when a finding is still a real defect the evidence supports or does not contradict, false when the findings look wrong, null when you cannot tell.',
		'Answer with only JSON: { "cause": "...", "label": "named_cause" | "other", "otherReal": true | false | null, "reason": "..." }',
	].join("\n");
}

export function parseGrade(text: string): Grade | null {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start < 0 || end <= start) return null;
	try {
		const value = JSON.parse(text.slice(start, end + 1)) as Record<
			string,
			unknown
		>;
		if (!(GRADE_LABELS as readonly unknown[]).includes(value.label))
			return null;
		return {
			label: value.label as GradeLabel,
			otherReal:
				value.label === "other" && typeof value.otherReal === "boolean"
					? value.otherReal
					: null,
			cause: typeof value.cause === "string" ? value.cause.slice(0, 600) : "",
			reason:
				typeof value.reason === "string" ? value.reason.slice(0, 1200) : "",
		};
	} catch {
		return null;
	}
}

/** One sample's outcome. */
export type Outcome =
	| "named_cause"
	| "other_real"
	| "other_not_real"
	| "other_unclear"
	| "missed"
	| "ungraded"
	| "no_run"
	| "control_pass"
	| "false_alarm"
	| "control_unsure";

export function outcomeOf(input: {
	readonly kind: SampleKind;
	/** null: the checker did not run or gave no record. */
	readonly verdict: AttemptVerdictKind | null;
	readonly grade: Grade | null;
}): Outcome {
	if (input.verdict === null) return "no_run";
	if (input.kind === "control")
		return input.verdict === "fail"
			? "false_alarm"
			: input.verdict === "unsure"
				? "control_unsure"
				: "control_pass";
	if (input.verdict === "pass") return "missed";
	if (!input.grade) return "ungraded";
	if (input.grade.label === "named_cause") return "named_cause";
	return input.grade.otherReal === true
		? "other_real"
		: input.grade.otherReal === false
			? "other_not_real"
			: "other_unclear";
}

export type Rates = {
	readonly n: number;
	readonly named: number;
	readonly other: number;
	readonly otherReal: number;
	readonly missed: number;
	readonly ungraded: number;
	readonly noRun: number;
	/** Of the samples with a checker run and a grade (or a pass verdict). */
	readonly detectionRate: number | null;
	readonly wrongCauseRate: number | null;
	readonly missRate: number | null;
};

export function failingRates(outcomes: readonly Outcome[]): Rates {
	const count = (...kinds: Outcome[]) =>
		outcomes.filter((outcome) => kinds.includes(outcome)).length;
	const named = count("named_cause");
	const other = count("other_real", "other_not_real", "other_unclear");
	const missed = count("missed");
	const decided = named + other + missed;
	const ratio = (part: number) => (decided ? part / decided : null);
	return {
		n: outcomes.length,
		named,
		other,
		otherReal: count("other_real"),
		missed,
		ungraded: count("ungraded"),
		noRun: count("no_run"),
		detectionRate: ratio(named),
		wrongCauseRate: ratio(other),
		missRate: ratio(missed),
	};
}

export function controlRates(outcomes: readonly Outcome[]) {
	const ran = outcomes.filter((outcome) => outcome !== "no_run");
	const falseAlarms = ran.filter((outcome) => outcome === "false_alarm").length;
	const unsure = ran.filter((outcome) => outcome === "control_unsure").length;
	return {
		n: outcomes.length,
		ran: ran.length,
		falseAlarms,
		unsure,
		falseAlarmRate: ran.length ? falseAlarms / ran.length : null,
		unsureRate: ran.length ? unsure / ran.length : null,
	};
}

const percent = (value: number | null) =>
	value === null ? "-" : `${Math.round(value * 100)}%`;

export function formatRates(label: string, rates: Rates) {
	return `${label}: ${rates.n} sample(s); named the cause ${rates.named} (${percent(rates.detectionRate)}), flagged something else ${rates.other} (${percent(rates.wrongCauseRate)}; ${rates.otherReal} of them real), missed (verdict pass) ${rates.missed} (${percent(rates.missRate)}); not graded ${rates.ungraded}, no checker run ${rates.noRun}.`;
}
