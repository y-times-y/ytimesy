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
) {
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
		`Harness tool profile v2 (${family}): ${editing} ${context}`,
		"Use execute_command with rg, Git and project CLIs; resume yielded ids with continue_command (input, EOF, wait, pages), never restart them. stop_command cancels. view_image supplies pixels. Independent calls run together; compose_tools links known result-dependent steps with explicit write ordering. Keep multi-step progress/evidence in update_plan; read_work_plan recovers it after restart.",
		"Read current source before edits; reread stale/ambiguous rejections. Never invent truncated source. Choose the least expensive safe workflow: batch known edits; use LSP renames/code actions when semantic uncertainty warrants them, not for every small refactor. Discover specialists with search_tools: outlines, LSP, debugging, memory, delegation, browser_execute. Outlines locate declarations, not replace source.",
		"Use scoped read_repository_guidance: ancestor instructions, referencedDocuments and scopeFiles are included. Read required bodies completely (read_files supports maxCharacters:128000); follow truncation cursors. Reuse unchanged complete evidence, not filename inventories as absence proof; reread after changes or genuine uncertainty.",
		"Patch implementation and tests together when no intermediate observation is needed. Use apply_patches.verification for formatting, preflightCommands and required checks, or run_checks. Biome formatting requires --error-on-warnings; no unsafe fixes, suppressed diagnostics or weakened policy.",
		"Verify the stable final tree; inspect resulting changes. Preserve every required check and full retained evidence. Concise runner reporting is allowed only without filtering tests or hiding warnings/errors. Each command needs its actual exit and stop status; include output references in the handoff.",
	].join(" ");
}
