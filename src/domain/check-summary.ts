/** A card shows pass or fail; anything else (an older "unsure") is no verdict, neutral. */
export type CheckVerdict = "pass" | "fail";

import type { DynamicToolCallItem } from "./session-item";

/** The tool name of the review loop's chat record (server/services/review-loop.ts). */
export const REVIEW_CHECK_TOOL = "review_check";
/** The tool name of the attempt loop's chat record (server/services/attempt-loop.ts). */
export const ATTEMPT_CHECK_TOOL = "attempt_check";

export type CheckRound = {
	readonly n: number;
	/** pass | fail, or null while checking / with no verdict (older "unsure" records too). */
	readonly verdict: CheckVerdict | null;
	/** The round's line after its number, as the loop wrote it. */
	readonly text: string;
	readonly findings: number;
	/** "fixed 1, rejected 1", the builder's answer to the findings. */
	readonly responses?: string;
	readonly kept?: boolean;
};

/** A review_check or attempt_check record, read back for a compact verdict card. */
export type CheckSummary = {
	readonly kind: "review" | "attempts";
	/** The round this record is about (the latest), and the most the loop runs. */
	readonly round: number | null;
	readonly maxRounds: number | null;
	readonly rounds: readonly CheckRound[];
	/** The latest round's verdict (attempts: the kept attempt's). */
	readonly verdict: CheckVerdict | null;
	readonly findings: readonly string[];
	readonly failingTests: readonly {
		readonly name: string;
		readonly command?: string;
	}[];
	/** Tests the checker ran, when the record says (newer records). */
	readonly tests?: { readonly run: number; readonly failed: number };
	/** Why the loop stopped before a pass. */
	readonly ended?: string;
	readonly selection?: string;
	/** "Checker spent 182k tokens · $0.44." */
	readonly spend?: string;
};

const verdictOf = (text: string): CheckVerdict | null =>
	text.startsWith("pass") ? "pass" : text.startsWith("fail") ? "fail" : null;

/** The verdict card's data, or null for any other tool call. */
export function checkSummary(item: DynamicToolCallItem): CheckSummary | null {
	if (item.tool !== REVIEW_CHECK_TOOL && item.tool !== ATTEMPT_CHECK_TOOL)
		return null;
	const kind = item.tool === REVIEW_CHECK_TOOL ? "review" : "attempts";
	const of = /(\d+) of up to (\d+)/.exec(item.input ?? "");
	const rounds: CheckRound[] = [];
	const findings: string[] = [];
	const failingTests: { name: string; command?: string }[] = [];
	let tests: CheckSummary["tests"];
	let ended: string | undefined;
	let selection: string | undefined;
	let spend: string | undefined;
	for (const line of (item.output ?? "").split("\n")) {
		const round = /^(?:Review|Attempt) (\d+): (.*)$/.exec(line);
		if (round) {
			const text = round[2];
			const [head, ...rest] = text.split(" · ");
			rounds.push({
				n: Number(round[1]),
				verdict: verdictOf(head),
				text,
				findings: Number(/\((\d+) findings?\)/.exec(head)?.[1] ?? 0),
				responses: rest.find((part) => /fixed|rejected|fixing/.test(part)),
				kept: rest.includes("kept"),
			});
			continue;
		}
		const finding = /^(F\d+)\. (.*)$/.exec(line);
		if (finding) {
			findings.push(`${finding[1]}. ${finding[2]}`);
			continue;
		}
		const failing = /^Failing test: (.*?)(?: \(`(.*)`\))?$/.exec(line);
		if (failing) {
			failingTests.push({
				name: failing[1],
				...(failing[2] ? { command: failing[2] } : {}),
			});
			continue;
		}
		const counted = /^Checker tests: (\d+) run, (\d+) failed\.$/.exec(line);
		if (counted) {
			tests = { run: Number(counted[1]), failed: Number(counted[2]) };
			continue;
		}
		if (line.startsWith("Review ended: ")) ended = line.slice(14);
		else if (line.startsWith("Selection: ")) selection = line.slice(11);
		else if (/^(?:Checker )?[Ss]pent /.test(line)) spend = line;
	}
	const latest =
		kind === "attempts"
			? (rounds.find((round) => round.kept) ?? rounds.at(-1))
			: rounds.at(-1);
	return {
		kind,
		round: of ? Number(of[1]) : (latest?.n ?? null),
		maxRounds: of ? Number(of[2]) : null,
		rounds,
		verdict: latest?.verdict ?? null,
		findings,
		failingTests,
		...(tests ? { tests } : {}),
		...(ended ? { ended } : {}),
		...(selection ? { selection } : {}),
		...(spend ? { spend } : {}),
	};
}
