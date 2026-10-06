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
			? "For multi-line edits prefer the provided native apply_patch tool and its documented operation schema. Submit V4A patch content, not shell patch commands. Read the current source first; stale patches must be reread, not force-applied."
			: "For a small edit prefer replace_text with an exact, uniquely matching oldText from a current read. For a multi-file change use apply_patches with its operations array and V4A syntax. Never invent a line range or patch from a truncated read; inspect current source after a stale or ambiguous edit rejection.";
	const context =
		family === "anthropic"
			? "Signed thinking is provider-managed continuation state, not editable text. Recover earlier findings with history/archive tools instead of reconstructing or exposing signatures."
			: family === "google"
				? "Thought signatures are provider-managed continuation state. Do not reconstruct them or claim a missing thought was recovered; use source and archive evidence."
				: "Opaque reasoning is provider-managed state. Use recoverable source/tool evidence, not guessed reasoning, after compaction.";
	const economy =
		"read_repository_guidance includes scopeFiles, a bounded inventory of non-hidden source paths in the requested scope. Use it to choose relevant reuse candidates and batch their reads with scoped searches; do not list the same scope again unless scopeFilesTruncated, a changed tree or missing evidence requires it. Filename inventory is not proof that equivalent logic is absent: inspect relevant source and search implementations before writing. " +
		"When configured scripts directly run Vitest or Vite, use their supported concise reporting flags (for example pnpm test --reporter=dot and pnpm build --logLevel warn) in run_checks; these keep all checks and warning/error diagnostics while avoiding long successful progress logs. Do not change dependencies, test filters or isolation settings to improve timing. " +
		"When a complete coherent patch and verification commands are known, use apply_patches.verification to order its successful writes, project formatting and all required independent checks in one call. If the project uses Biome, run its formatting/check stage with --write --error-on-warnings against changed files so newly introduced warnings stop the pipeline BEFORE expensive checks, rather than triggering a second full verification round. Do not hide or suppress diagnostics, use unsafe fixes, or change repository lint rules. Do not edit while verification runs; inspect final changes afterward and repair any failures. Otherwise, after completing coherent edits and formatting, prefer one run_checks call containing focused tests and every required project check, rather than a separate model turn per command start, wait and output read. Use the actual configured commands. Treat each returned exit and stop reason independently; retrieve complete retained output when paginated, and rerun affected checks only after further edits. Read and follow the configured lint rules before writing, not just after a rejected check. " +
		"For known task paths, use the path option on search_files/list_files for those directories instead of enumerating the whole repository unnecessarily. Batch independent reuse queries and required file reads. When several new files are already planned, prefer one apply_patches call; independent create_file calls may share one tool batch rather than separate model steps. Use readable table-driven tests for repetitive boundary cases without reducing coverage. Match validation to the stated contract: do not reject additional otherwise valid inputs just because stricter validation seems safer. For full-string validation remember JavaScript $ also matches before a trailing newline; enforce the actual whole-string contract. Narrow discriminated union results before accessing branch-specific fields in typed tests. Prefer runner-supported concise reporting for large checks (for example Vitest --reporter=dot and Vite --logLevel warn after checking the actual project scripts) without filtering tests, hiding warnings/errors or changing required checks. Do not replace failures with empty logs or shell-output filters. Preserve complete captured evidence and include its references in the final handoff.";
	return `Harness tool profile v1 (${family}): ${editing} ${context} ${economy} For fully specified new modules, include implementation and associated tests in the same apply_patches batch when no intermediate observation is needed; splitting source and tests across separate inference steps adds latency without new evidence. Tool search makes optional capabilities available on demand. Batch known files with read_files, including applicable instruction/skill bodies and their referenced required documents; request maxCharacters:128000 when a complete required document is large. Read repository guidance for the most specific known scope: it includes root and ancestor instructions, so a second root-only call is unnecessary. Complete referencedDocuments and root configuration bodies already supplied by that call do not need a separate read_file. Batch independent initial guidance, scoped reuse searches and environment reads together rather than one observation per inference. Review independent completed children with batched inspect_task_diff and read_task_output calls, then accept only the exact verified hashes. Do not reread unchanged complete evidence already in this context; reread after edits, branch changes, incomplete reads or genuine uncertainty. Parallel tool calls are suitable for independent reads; dependent writes and calls consuming a previous result must be ordered.`;
}
