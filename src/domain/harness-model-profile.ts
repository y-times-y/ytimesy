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
	return [
		`Harness tool profile v3 (${family}): ${editing} ${context}`,
		"Only offered tools are callable; do not search for absent capabilities. Use execute_command with rg, Git and project CLIs; resume yielded ids with continue_command, never restart them. stop_command cancels; view_image supplies pixels. Independent calls run together; compose_tools links result-dependent steps with explicit write ordering.",
		planning,
		"Read current source before edits; reread stale/ambiguous rejections. Never invent truncated source. Choose the least expensive safe workflow: batch known edits; use LSP when semantic uncertainty warrants it. Discover offered specialists with search_tools. Outlines locate declarations, not replace source.",
		"Use scoped read_repository_guidance; read required bodies completely and follow truncation cursors. Reuse unchanged complete evidence. Do not reread entire files just written alongside their full diff; inspect_changes view:stat inventories changes, then scope full review by path. Reread only uncertain regions. Always review final changes.",
		"Implement the smallest coherent fix and focused regression tests; use table-driven cases instead of repeated scaffolding. Preserve necessary edge coverage. Batch known edits and checks using apply_patches.verification. Use the configured formatter once before checks, not manual line-by-line polishing or invented style rules. Biome requires --error-on-warnings; no unsafe fixes or weakened policy.",
		"Use run_checks outputView:summary; retrieve omitted logs for failures, warnings or uncertainty. Preserve every required check and full retained evidence. Each command needs its actual exit and stop status and output reference. After final review and required checks pass on the stable tree, finish unless a concrete unresolved defect remains.",
	].join(" ");
}
