/**
 * When and how a builder delegates: one policy for the product's
 * orchestration block (subagent-instructions.ts) and the Harbor bridge's
 * helper section (evals/harbor_v2/helpers.ts), so a benchmark score holds
 * for the product. Only the mechanics differ and stay with each caller:
 * where a helper runs (a fork or the shared VM vs one container, writers
 * limited by `owns`), how reports arrive (messages vs agent_wait) and how a
 * writer's work is integrated (a patch to apply vs edits in place).
 *
 * The wording is the bridge's helpers=write section as measured on
 * Terminal-Bench (2026-10-27); change it only with a new measurement.
 */

/**
 * Writers: decided once, right after the first look, and only for work
 * that splits into large parts that can be built and checked separately.
 */
export const WRITER_DELEGATION_POLICY =
	"Writers: decide once, after your first look at the task and its files, and never later. Start writers only when the work splits into two or more parts that can be built and checked separately and each part is a large job on its own (hours of work or thousands of lines). Give each writer its own files or directories, never ones another agent changes, and state the interfaces between the parts in the briefs. While they work, do your own part in other files; then integrate their parts and run the final checks yourself. Otherwise do all the work yourself.";

/** Readers (researcher, reviewer): the cost bar. */
export const READER_DELEGATION_POLICY =
	"A helper costs about as much as you do and re-reads what it needs. Start one only for an independent investigation likely to take over 10 minutes, while you have other work to do meanwhile. Small, quick or sequential work, or anything you would finish in a few steps, you do yourself.";

/** What every brief carries. */
export const BRIEF_POLICY =
	"Every brief is self-contained: the goal, the paths and findings it needs, constraints and the report format.";

/** Do not wait on helpers; stop the ones no longer needed. */
export const KEEP_WORKING_POLICY =
	"Keep working while helpers run. Once you have what you need, stop running helpers with agent_send instead of waiting for them.";

/** A report is checked before it is relied on. */
export const REPORT_IS_A_CLAIM =
	"A report is a claim: spot-check it before relying on it.";

/** A refused start (depth, budget, concurrency) is not retried. */
export const REFUSED_START = "A refused start means do the work yourself.";
