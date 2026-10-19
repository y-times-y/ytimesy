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
	/** The checker's whole requirement table (met, unmet, unchecked). */
	readonly requirements?: readonly {
		readonly requirement: string;
		readonly met: boolean | null;
		readonly evidence: string;
	}[];
	readonly assumptions?: readonly {
		readonly assumption: string;
		readonly alternative: string;
		readonly outcome: string;
	}[];
};

/** Anonymous id for a sample on the grading sheet (the grader never sees task or trial names). */
export const blindId = (sampleId: string) => `S-${rank(sampleId).slice(0, 8)}`;

/**
 * named_cause: a finding names the defect behind a failing hidden check;
 * partial: a finding is about that defect but too vague, mis-diagnosed or
 * only part of it; other_real: the cause is not named but a finding is a real
 * defect; wrong: the concrete findings are wrong; none: no concrete finding.
 */
export const GRADE_LABELS = [
	"named_cause",
	"partial",
	"other_real",
	"wrong",
	"none",
] as const;
export type GradeLabel = (typeof GRADE_LABELS)[number];

export type Grade = {
	readonly label: GradeLabel;
	/** The grader's one-line statement of the hidden failure's cause. */
	readonly cause: string;
	readonly reason: string;
	/** The finding (1-based, as listed) that names or touches the cause. */
	readonly finding?: number | null;
	/** A grade in the earlier two-label format, mapped on read. */
	readonly legacy?: boolean;
};

export const GRADE_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: ["cause", "label", "finding", "reason"],
	properties: {
		cause: { type: "string" },
		label: { type: "string", enum: [...GRADE_LABELS] },
		finding: { type: ["integer", "null"] },
		reason: { type: "string" },
	},
} as const;

const MAX_FINDINGS_TEXT = 40_000;

/** The checker's findings as the grader reads them: numbered findings, the requirement table, assumptions. */
export function findingsText(findings: CheckerFindings) {
	const listed = [
		...findings.failures,
		...findings.unmetRequirements.filter(
			(entry) => !findings.failures.includes(entry),
		),
	];
	const requirements = findings.requirements ?? [];
	const assumptions = findings.assumptions ?? [];
	const lines = [
		"Findings:",
		...(listed.length
			? listed.map((finding, index) => `${index + 1}. ${finding}`)
			: ["(no specific finding)"]),
		...(requirements.length
			? [
					"",
					"Requirement table (met / NOT MET / unchecked, with the reviewer's evidence):",
					...requirements.map(
						(entry) =>
							`- [${entry.met === true ? "met" : entry.met === false ? "NOT MET" : "unchecked"}] ${entry.requirement}${entry.evidence ? ` -- ${entry.evidence}` : ""}`,
					),
				]
			: []),
		...(assumptions.length
			? [
					"",
					"Assumptions the reviewer examined:",
					...assumptions.map(
						(entry) =>
							`- ${entry.assumption}${entry.alternative ? ` | alternative: ${entry.alternative}` : ""}${entry.outcome ? ` | outcome: ${entry.outcome}` : ""}`,
					),
				]
			: []),
		...(findings.notes ? ["", `Notes: ${findings.notes}`] : []),
	];
	return clipHead(lines.join("\n"), MAX_FINDINGS_TEXT);
}

/** The grader's prompt for one failing sample (the checker's verdict is fail or unsure). */
export function gradingPrompt(input: {
	readonly instruction: string;
	readonly evidence: string;
	readonly findings: CheckerFindings;
}) {
	return [
		"You grade a reviewer. A task's hidden tests failed the delivered work. Separately, a reviewer who could not see the tests inspected the same work and reported findings. Decide whether the reviewer found what made the hidden tests fail.",
		"",
		"<task>",
		clipHead(input.instruction, 8000),
		"</task>",
		"",
		"<hidden_test_failure>",
		input.evidence,
		"</hidden_test_failure>",
		"",
		"<reviewer_report>",
		findingsText(input.findings),
		"</reviewer_report>",
		"",
		"First state the cause of the hidden failure in one line, from the test output (when the output is only a summary, use the task text to infer what the failing checks test). Then read every finding and the NOT MET rows of the requirement table, and judge on substance, not wording: the reviewer never saw the tests, so the same defect counts even when described from the requirement's side, through a different symptom, or found by a different route.",
		"Label:",
		'- "named_cause": a finding (or NOT MET row) identifies the defect behind at least one failing check, specifically enough that fixing what it says would make that check pass.',
		'- "partial": a finding is about that defect or the requirement it breaks, but is too vague, gets the mechanism wrong, or covers only part of it, so fixing it alone would likely not make a failing check pass.',
		'- "other_real": no finding is about the cause, but at least one concrete finding is a real defect (supported by the task and evidence, or plausible and not contradicted).',
		'- "wrong": there are concrete findings, none about the cause, and they look wrong (contradicted by the task or the evidence).',
		'- "none": no concrete finding (only "could not verify" statements or no findings).',
		"Set finding to the number of the finding that names or touches the cause (null when none does).",
		'Answer with only JSON: { "cause": "...", "label": "named_cause" | "partial" | "other_real" | "wrong" | "none", "finding": <number or null>, "reason": "..." }',
	].join("\n");
}

/** A grade from the grader's answer; the earlier {named_cause|other, otherReal} format is mapped. */
export function parseGrade(text: string): Grade | null {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start < 0 || end <= start) return null;
	try {
		const value = JSON.parse(text.slice(start, end + 1)) as Record<
			string,
			unknown
		>;
		return gradeFromUnknown(value);
	} catch {
		return null;
	}
}

export function gradeFromUnknown(value: unknown): Grade | null {
	if (!value || typeof value !== "object") return null;
	const record = value as Record<string, unknown>;
	const cause =
		typeof record.cause === "string" ? record.cause.slice(0, 600) : "";
	const reason =
		typeof record.reason === "string" ? record.reason.slice(0, 1200) : "";
	if ((GRADE_LABELS as readonly unknown[]).includes(record.label))
		return {
			label: record.label as GradeLabel,
			cause,
			reason,
			finding:
				typeof record.finding === "number" && Number.isInteger(record.finding)
					? record.finding
					: null,
			...(record.legacy === true ? { legacy: true } : {}),
		};
	if (record.label === "other")
		return {
			label:
				record.otherReal === true
					? "other_real"
					: record.otherReal === false
						? "wrong"
						: "none",
			cause,
			reason,
			finding: null,
			legacy: true,
		};
	return null;
}

/** One sample's outcome. */
export type Outcome =
	| "named_cause"
	| "partial"
	| "other_real"
	| "wrong"
	| "none"
	| "missed"
	| "ungraded"
	| "no_run"
	| "unfit"
	| "control_pass"
	| "false_alarm"
	| "control_unsure";

export function outcomeOf(input: {
	readonly kind: SampleKind;
	/** null: the checker did not run or gave no record. */
	readonly verdict: AttemptVerdictKind | null;
	readonly grade: Grade | null;
	/** The sample cannot be restored faithfully (reported apart, never in a rate). */
	readonly unfit?: boolean;
}): Outcome {
	if (input.unfit) return "unfit";
	if (input.verdict === null) return "no_run";
	if (input.kind === "control")
		return input.verdict === "fail"
			? "false_alarm"
			: input.verdict === "unsure"
				? "control_unsure"
				: "control_pass";
	if (input.verdict === "pass") return "missed";
	if (!input.grade) return "ungraded";
	return input.grade.label;
}

export type Rates = {
	readonly n: number;
	readonly named: number;
	readonly partial: number;
	readonly otherReal: number;
	readonly wrong: number;
	readonly none: number;
	readonly missed: number;
	readonly ungraded: number;
	readonly noRun: number;
	readonly unfit: number;
	/** Of the fit samples with a checker run and a grade (or a pass verdict). */
	readonly detectionRate: number | null;
	readonly partialRate: number | null;
	readonly missRate: number | null;
};

export function failingRates(outcomes: readonly Outcome[]): Rates {
	const count = (...kinds: Outcome[]) =>
		outcomes.filter((outcome) => kinds.includes(outcome)).length;
	const named = count("named_cause");
	const partial = count("partial");
	const otherReal = count("other_real");
	const wrong = count("wrong");
	const none = count("none");
	const missed = count("missed");
	const decided = named + partial + otherReal + wrong + none + missed;
	const ratio = (part: number) => (decided ? part / decided : null);
	return {
		n: outcomes.length,
		named,
		partial,
		otherReal,
		wrong,
		none,
		missed,
		ungraded: count("ungraded"),
		noRun: count("no_run"),
		unfit: count("unfit"),
		detectionRate: ratio(named),
		partialRate: ratio(partial),
		missRate: ratio(missed),
	};
}

export function controlRates(outcomes: readonly Outcome[]) {
	const ran = outcomes.filter(
		(outcome) => outcome !== "no_run" && outcome !== "unfit",
	);
	const falseAlarms = ran.filter((outcome) => outcome === "false_alarm").length;
	const unsure = ran.filter((outcome) => outcome === "control_unsure").length;
	return {
		n: outcomes.length,
		ran: ran.length,
		unfit: outcomes.filter((outcome) => outcome === "unfit").length,
		falseAlarms,
		unsure,
		falseAlarmRate: ran.length ? falseAlarms / ran.length : null,
		unsureRate: ran.length ? unsure / ran.length : null,
	};
}

const percent = (value: number | null) =>
	value === null ? "-" : `${Math.round(value * 100)}%`;

export function formatRates(label: string, rates: Rates) {
	const decided =
		rates.named +
		rates.partial +
		rates.otherReal +
		rates.wrong +
		rates.none +
		rates.missed;
	return `${label}: ${rates.n} sample(s), ${decided} decided; named the cause ${rates.named} (${percent(rates.detectionRate)}), partial ${rates.partial} (${percent(rates.partialRate)}), other real defect ${rates.otherReal}, wrong ${rates.wrong}, no concrete finding ${rates.none}, missed (verdict pass) ${rates.missed} (${percent(rates.missRate)}); not graded ${rates.ungraded}, no checker run ${rates.noRun}, unfit (left out) ${rates.unfit}.`;
}
