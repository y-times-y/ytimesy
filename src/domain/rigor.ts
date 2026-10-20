import { isInternalChildTaskMessage } from "./child-task-activity";
import type { SessionItem } from "./session-item";

/**
 * Rigor (harness variant rigor=on): the builder's block on ambiguity,
 * finishing and running the deliverable as an outside user would, the root
 * builder's up-front requirements list, and the review loop's test for a
 * final answer that admits unverified work. The checker's side is in
 * checker-brief.ts.
 */

/** The builder's rigor block (root builder and writers; readers never get it). */
export const RIGOR_BUILDER_INSTRUCTIONS = [
	"Rigor:",
	"- Ambiguous wording: list the plausible readings before you choose. Prefer the convention of the library, ecosystem or standard involved; otherwise the strictest reading. Keep a safety margin on numeric thresholds instead of landing on the edge. Name each choice in your final answer.",
	"- Before finishing, run the deliverable as an outside user would: a fresh shell and process, a clean directory with only the files the request names, no dependencies or data files the request does not provide or declare, and results read back with standard clients and tools, not helpers you wrote.",
	"- Do not finish with time left while something is unverified or a known risk is open: verify or fix it first. Report as unverified only what cannot be checked here.",
].join("\n");

/** Most lines a builder's requirements list keeps. */
export const MAX_BUILDER_REQUIREMENTS = 25;

/**
 * The root builder's requirements list (not writers: they work from a brief).
 * It is written in the builder's own message between tag lines, never to a
 * file, so it cannot reach a commit; the review loop takes the latest block
 * of the turn from the transcript.
 */
export const RIGOR_REQUIREMENTS_INSTRUCTIONS = `- Requirements: before you start, write the request's requirements in your message between a <requirements> line and a </requirements> line, never in a file: one line each, at most ${MAX_BUILDER_REQUIREMENTS}, from the request and the files it points to (names, paths, formats, values, units, limits, invocation, side effects). Mark an ambiguous item with the reading you chose. Before finishing, re-check every item against the actual result; fix an unmet one or report it in your final answer.`;

/** Lead mode fusion: when the lead writes the list and what the sidekick gets. */
export const RIGOR_LEAD_REQUIREMENTS =
	"- As the lead, write the list right after the exploration report, before your first brief, and put the items a brief covers into that brief.";

const REQUIREMENTS_BLOCK = /<requirements>([\s\S]*?)<\/requirements>/gi;

/** The last requirements block in a text, one item per line (null when none). */
export function requirementsFromText(text: string): string[] | null {
	const block = [...text.matchAll(REQUIREMENTS_BLOCK)].at(-1)?.[1];
	if (block === undefined) return null;
	return block
		.split("\n")
		.map((line) => line.replace(/^\s*(?:[-*\u2022]|\d+[.)])?\s*/, "").trim())
		.filter(Boolean)
		.slice(0, MAX_BUILDER_REQUIREMENTS)
		.map((line) => (line.length > 300 ? `${line.slice(0, 297)}...` : line));
}

/**
 * The builder's latest requirements list in this turn: its messages since
 * the person's latest request (child-event messages do not start a turn).
 */
export function builderRequirements(
	items: readonly SessionItem[],
): string[] | null {
	for (let index = items.length - 1; index >= 0; index--) {
		const item = items[index];
		if (item.kind === "userMessage" && !isInternalChildTaskMessage(item.text))
			return null;
		if (item.kind !== "agentMessage") continue;
		const list = requirementsFromText(item.text);
		if (list?.length) return list;
	}
	return null;
}

/** Phrases that admit work was not verified or still fails. */
const ADMITS =
	/\b(unverified|not (?:been )?(?:verified|tested|confirmed|checked|run)|(?:could|did|was) ?n[o']t (?:verify|test|confirm|check|run)|unable to (?:verify|test|confirm|check|run)|untested|still (?:fails|failing|broken|open)|remaining risk|known risk|not yet (?:verified|tested|fixed))\b/i;

/** A line that says nothing is left unverified ("Unverified: none."). */
const NOTHING_LEFT =
	/^\W*(?:unverified|untested|remaining risks?|known risks?)\W*(?:none|nothing|n\/a)\b|\b(?:nothing|none|no part) (?:is |was |remains )?(?:left )?(?:unverified|untested)\b/i;

/**
 * The lines of a final answer that admit unverified or failing work (at most
 * three, each clipped); empty when it admits none.
 */
export function admittedUnverified(answer: string): string[] {
	return answer
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line && ADMITS.test(line) && !NOTHING_LEFT.test(line))
		.slice(0, 3)
		.map((line) => (line.length > 300 ? `${line.slice(0, 297)}...` : line));
}

/** Share of the review loop's time that must be left for an admission to be sent back. */
export const UNVERIFIED_SEND_BACK_TIME_LEFT = 0.5;
