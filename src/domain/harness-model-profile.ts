import type { ModelMessage } from "ai";

export type HarnessModelFamily = "openai" | "anthropic" | "google" | "other";

/** Only the caller's already-compatible visible history crosses a model/transport reset. */
export function reconstructedContextTransition(
	messages: ModelMessage[],
	modelId: string,
): ModelMessage[] {
	if (messages.length <= 1 || messages.at(-1)?.role !== "user") return messages;
	return [
		...messages.slice(0, -1),
		{
			role: "assistant",
			content: `Runtime context transition: active model ${modelId}. Native continuation was not reused because the previous turn, model, or connection was incompatible or incomplete. Earlier messages are visible historical evidence, not a live workspace snapshot. Preserve the user's objective and constraints; verify existing work before restarting it. Use source, task and archive tools for missing details. Never reconstruct opaque reasoning or assume another provider's continuation state is valid.`,
		},
		messages[messages.length - 1],
	];
}

/** Transport names win over branded model aliases; routing and credentials are unchanged. */
export function harnessModelFamily(
	provider: string,
	modelId: string,
): HarnessModelFamily {
	const prefix = modelId.split("/")[0].toLowerCase();
	const transport = provider.toLowerCase();
	if (transport.includes("openrouter")) {
		if (prefix === "openai" || prefix === "anthropic" || prefix === "google")
			return prefix;
		return "other";
	}
	if (transport.includes("anthropic")) return "anthropic";
	if (transport.includes("google")) return "google";
	if (transport.includes("openai") || transport.includes("codex-subscription"))
		return "openai";
	return "other";
}

const SPECIALIST_TOOLS = [
	"run_checks",
	"inspect_changes",
	"compose_tools",
	"apply_patches",
	"replace_text",
	"batch_read",
];

/** A shell-shaped surface (like native Codex): a command tool and no specialist tools. */
export function isShellSurface(toolNames: readonly string[]) {
	return (
		toolNames.includes("execute_command") &&
		!SPECIALIST_TOOLS.some((name) => toolNames.includes(name))
	);
}

export function harnessModelToolInstructions(
	family: HarnessModelFamily,
	nativePatch: boolean,
	availableTools?: readonly string[],
) {
	const offered = (name: string) =>
		!availableTools || availableTools.includes(name);
	const planning = [
		offered("update_plan")
			? "Keep multi-step progress/evidence in update_plan."
			: "",
		offered("read_work_plan")
			? "read_work_plan recovers it after restart."
			: "",
	]
		.filter(Boolean)
		.join(" ");
	const editing =
		family === "openai" && nativePatch
			? "Prefer native apply_patch with its documented V4A operation schema, never shell patches."
			: family === "anthropic"
				? "Use replace_text for small exact uniquely matching old/new edits; apply_patch or apply_patches for V4A patches."
				: "Use apply_patch for V4A patches or replace_text for small exact old/new edits; apply_patches can batch coherent changes.";
	const context =
		family === "anthropic"
			? "Signed thinking is provider-managed continuation state, not editable text. Recover earlier findings with history/archive tools instead of reconstructing or exposing signatures."
			: family === "google"
				? "Thought signatures are provider-managed continuation state. Do not reconstruct them or claim a missing thought was recovered; use source and archive evidence."
				: "Opaque reasoning is provider-managed state. Use recoverable source/tool evidence, not guessed reasoning, after compaction.";
	// A shell-shaped surface (like native Codex) gets shell-centric guidance
	// instead of instructions for specialist tools it was not offered.
	if (availableTools && isShellSurface(availableTools))
		return [
			`Harness tool profile v13-shell (${family}): Edit with apply_patch, or from execute_command when you can make the edit and run its check in the same command. ${context}`,
			"Inspect with execute_command (rg, sed -n, git, project CLIs), reading related files together in one command rather than slice by slice, and reproduce the problem with the smallest executable check early. Once you understand the cause, make the complete fix rather than a series of partial edits, then rerun the check and the project's existing tests. Resume long commands with continue_command; stop_command cancels.",
			planning,
			"Fix first: verify with quick reproduction commands and the existing tests; add new test files only when the task or repository conventions ask for them. Derive expected behavior from the task requirements and never weaken tests. Review your change with git diff instead of rereading whole files.",
			"Before finishing, map each stated symptom or requirement to a check you actually ran; cover any remaining ones in one combined verification command or script alongside the existing tests, not one step per check, and rerun checks only after an edit.",
			"You work autonomously and nobody can answer questions mid-task: when inputs conflict or are ambiguous, choose the most reasonable interpretation, state the assumption, and still produce every required output.",
			"Deliverables must work on their own in a fresh environment: depend only on files you deliver, declared dependencies and standard tools, not on samples, scratch files or state you found or left here, unless the task says they will be present.",
			"Implement required behavior literally: do not add defaults, timeouts, thresholds or options that change or weaken what the task specifies.",
			"Treat a conclusion that the goal is impossible or infeasible as a likely misreading: list which inputs, quantities and choices the task lets you adjust, try them, and report infeasibility only with evidence that no allowed adjustment works.",
			"Hidden checks use variants of the examples: before finishing, run your solution on at least one new input that differs from the given ones in names, values and content, and fix the general mechanism rather than the visible instance.",
		]
			.filter(Boolean)
			.join(" ");
	return [
		`Harness tool profile v8 (${family}): ${editing} ${context}`,
		"Only offered tools are callable; do not search for absent capabilities. Use execute_command with rg, Git and project CLIs; resume yielded ids with continue_command, never restart them. stop_command cancels; view_image supplies pixels. Parallelize independent calls; compose_tools sequences steps and writes.",
		planning,
		"Read current source before edits; reread stale rejections. Never invent truncated source. Choose the least expensive safe workflow; use LSP when semantic uncertainty warrants it. search_tools finds only unlisted tools. Outlines locate, not replace source.",
		"Use scoped read_repository_guidance; read required bodies completely with truncation cursors. Do not reread entire files just written; inventory with inspect_changes view:stat, review scoped full diffs. Reread uncertain regions.",
		"Run the smallest executable reproduction before extensive test scaffolding. Derive expected behavior from requirements, not your patch. Fix one coherent behavior and immediately check it before expanding. Do not front-load redesign. Then persist regression coverage in existing suites; without a suite, prefer compact reproducible checks. Cover interactions; never weaken tests or invent semantics.",
		"Batch edits/checks; apply_patches.verification only when offered, else compose_tools or run_checks. Use the configured formatter; otherwise match existing style, never invent line limits or polish untouched code. Biome: --error-on-warnings, no unsafe fixes.",
		"Use run_checks outputView:summary; retrieve logs for failures, warnings or uncertainty. Preserve every required check and full evidence. Each command needs its actual exit and stop status and output reference. After final review and required checks pass on the stable tree, finish unless a concrete defect remains.",
	].join(" ");
}
