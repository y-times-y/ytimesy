/**
 * Rigor (harness variant rigor=on): the builder's block on ambiguity,
 * finishing and running the deliverable as an outside user would, and the
 * review loop's test for a final answer that admits unverified work. The
 * checker's side is in checker-brief.ts.
 */

/** The builder's rigor block (root builder and writers; readers never get it). */
export const RIGOR_BUILDER_INSTRUCTIONS = [
	"Rigor:",
	"- Ambiguous wording: list the plausible readings before you choose. Prefer the convention of the library, ecosystem or standard involved; otherwise the strictest reading. Keep a safety margin on numeric thresholds instead of landing on the edge. Name each choice in your final answer.",
	"- Before finishing, run the deliverable as an outside user would: a fresh shell and process, a clean directory with only the files the request names, no dependencies or data files the request does not provide or declare, and results read back with standard clients and tools, not helpers you wrote.",
	"- Do not finish with time left while something is unverified or a known risk is open: verify or fix it first. Report as unverified only what cannot be checked here.",
].join("\n");

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
