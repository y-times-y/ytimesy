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
				? "For small edits discover replace_text and supply exact uniquely matching old/new text. Batch coherent multi-file changes with apply_patches (V4A)."
				: "Batch coherent edits with apply_patches (V4A); discover replace_text for small exact old/new replacements.";
	const context =
		family === "anthropic"
			? "Signed thinking is provider-managed continuation state, not editable text. Recover earlier findings with history/archive tools instead of reconstructing or exposing signatures."
			: family === "google"
				? "Thought signatures are provider-managed continuation state. Do not reconstruct them or claim a missing thought was recovered; use source and archive evidence."
				: "Opaque reasoning is provider-managed state. Use recoverable source/tool evidence, not guessed reasoning, after compaction.";
	return [
		`Harness tool profile v2 (${family}): ${editing} ${context}`,
		"Read current source before edits; reread after stale/ambiguous rejection. Never invent missing source from truncated output. Use read_code outlines to locate declarations in large TS/JS files, then exact line selections before editing. Batch independent code inspections with inspect_code_batch; discover rename_symbol for language-server symbol refactors. Order dependent calls and writes.",
		"Use scoped read_repository_guidance: ancestor instructions, referencedDocuments and scopeFiles are included. Read required bodies completely (read_files supports maxCharacters:128000); follow truncation cursors. Reuse unchanged complete evidence, not filename inventories as absence proof; reread after changes or genuine uncertainty. Discover optional tools with search_tools.",
		"Include implementation and tests in one coherent patch when no intermediate observation is needed. Use apply_patches.verification for formatting, fast preflightCommands, then all required checks; otherwise use run_checks. Follow configured lint rules. Biome formatting must use --error-on-warnings; no unsafe fixes, suppressed diagnostics or weakened policy.",
		"Verify the stable final tree; inspect resulting changes. Preserve every required check and full retained evidence. Concise runner reporting is allowed only without filtering tests or hiding warnings/errors. Each command needs its actual exit and stop status; include output references in the handoff.",
	].join(" ");
}
