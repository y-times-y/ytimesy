/**
 * Known TB4 dataset defects (docs/tb4-readiness.md, "Known dataset defects").
 *
 * A task listed here failed its preflight because of the published task itself
 * (its reference solution or image), not our infrastructure. The readiness gate
 * reports it as "dataset defect" instead of failing item 1, but only while its
 * preflight failure is exactly the recorded one. Any other outcome (a different
 * reason, an exception, a nop that scores, a missing record) stays strict.
 *
 * Add an entry only with the evidence string from the oracle log and the
 * preflight record that shows it.
 */
export type KnownDefect = {
	task: string;
	/** The preflight `reason` this defect produces, matched exactly. */
	reason: string;
	/** What the oracle log shows; the line that proves it is the dataset. */
	evidence: string;
	/** Where the evidence was recorded. */
	source: string;
};

export const KNOWN_DATASET_DEFECTS: KnownDefect[] = [
	{
		task: "cad-model",
		reason: "oracle scored 0 (needs 1)",
		evidence: "ModuleNotFoundError: No module named 'OCP.collections'",
		source:
			".ytimesy/tb4-preflight/20261021T2339Z/results.json (failed twice, also rerun alone; the reference solution exits 1 and writes no /app/out.step)",
	},
];

export type PreflightEntry = { passed: boolean; reason: string | null };
export type PreflightVerdict = "passed" | "dataset-defect" | "failed" | "missing";

export function preflightVerdict(
	task: string,
	entry: PreflightEntry | undefined,
	defects: KnownDefect[] = KNOWN_DATASET_DEFECTS,
): PreflightVerdict {
	if (!entry) return "missing";
	if (entry.passed) return "passed";
	const defect = defects.find((d) => d.task === task);
	return defect && entry.reason === defect.reason ? "dataset-defect" : "failed";
}
