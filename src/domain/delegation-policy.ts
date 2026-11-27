/**
 * When and how a builder delegates: one policy for the product's
 * orchestration block (subagent-instructions.ts) and the Harbor bridge's
 * helper section (evals/harbor_v2/helpers.ts), so a benchmark score holds
 * for the product. Only the mechanics differ and stay with each caller:
 * where a helper runs (a fork or the shared VM vs one container, writers
 * limited by `owns`), how reports arrive (messages vs agent_wait) and how a
 * writer's work is integrated (a patch to apply vs edits in place).
 *
 * The writer and reader rules are the "middle" rule (2026-10-28): between
 * the bridge's measured helpers=write wording (strict: parts of hours of
 * work) and the product's old wall-clock triggers. Measured on the product
 * delegation probe (evals/delegation-probe) and Terminal-Bench trigger runs;
 * change it only with a new measurement.
 */

/**
 * Writers: decided once, right after the first look, when the work splits
 * into separate parts that are each a real job; one focused change stays
 * with the builder.
 */
export const WRITER_DELEGATION_POLICY =
	"Writers: decide once, after your first look at the task and its files, and never later. Start writers when the work splits into two or more parts that touch different files, can each be built and checked without the others, and are each a real job on its own (their own investigation, change and checks, not a few edits): one writer per part, started together. Give each writer its own files or directories, never ones another agent changes, and state the interfaces between the parts in the briefs. While they work, do your own part in other files; then integrate their parts and run the final checks yourself. One focused change, even across several files, or steps that depend on each other, you do yourself.";

/** Readers (researcher, reviewer): the cost bar and when it is worth it. */
export const READER_DELEGATION_POLICY =
	"A helper costs about as much as you do and re-reads what it needs; what it buys is time and a smaller context for you. Start one only for an independent investigation likely to take over 10 minutes, while you have other work to do meanwhile; when a broad investigation splits into several such areas, start one per area together. Small, quick or sequential work, or anything you would finish in a few steps, you do yourself.";

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

/**
 * The product's own rules (2026-11-27). The strict ones above are tuned on
 * GPT and stay for the Harbor bridge. Measured on Claude, they left Sonnet and
 * Haiku at 0 of 24 parallelisable prompts and production Sonnet at 1.4% of
 * turns (docs/research/experiment-log.md): "over 10 minutes", "decide once"
 * and "few steps yourself" read as "do it yourself" to a model that cannot
 * time its own work. Readers share the VM read-only and add no machine, so
 * the product invites them freely; writers are neutral (no quota): the
 * platform's own limits (8 agents in a tree, depth 3, the usage window) bound them.
 */
export const PRODUCT_READER_POLICY =
	"Readers (researcher, reviewer) share your VM read-only and start at once: use them freely for research, exploration, review and large reads. When a request names two or more files, areas, questions or sources to investigate or review, start one reader per item together in one step and work on the rest or synthesize as the reports arrive; so too when a read would flood your context. Decide from the request itself, before you read the items one by one yourself: a quick look to name the areas is enough. Do a single small lookup or one quick edit yourself.";

export const PRODUCT_WRITER_POLICY =
	"Writers edit on a fork of your VM: start as many as the work needs whenever it splits into independent edits (different files or directories that can be built and checked without the others), one per part, together, each with its own files and the interfaces between parts in the briefs. Do your own part meanwhile, then integrate and run the final checks. A change whose steps depend on each other you do yourself.";

export const PRODUCT_READER_EXAMPLE =
	'Example: "review these three files" or "investigate X and Y" -> one reader per file or question in one step, then answer from their reports.';

export const PRODUCT_DELEGATION_EXAMPLES = `${PRODUCT_READER_EXAMPLE} Example: "add the export endpoint and its UI" (separate directories) -> one writer per part, together.`;

/** The `agent` tool's declaration: what it is and when to reach for it (token-cheap; the system prompt has the detail). */
export const AGENT_TOOL_DESCRIPTION =
	"Start a subagent in the background; it sees only your brief (never this conversation), works within its own budget and reports back as a message while you keep working. Use it for research, exploration, review and large reads (researcher/reviewer: share your VM read-only, start at once, use freely; one per file, area or question, together in one step) and for independent edits that can be built apart (writer: gets a fork of your VM, uncommitted work included, and returns a patch and git ref to review and apply; one per part, together). Do a small lookup or one quick edit yourself. Returns its id and budget.";
