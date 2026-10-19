const CHECK_ARTIFACT_CLEANUP_POLICY =
	"Undo generated-only artifacts from your own checks only in an exclusive checkout with evidence they were clean before the check and no intervening user/peer edits; preserve pre-existing edits. Restore only those exact files to the recorded pre-check state, never reset the tree or expand implementation scope. Otherwise report the scope question.";

const CONTRACT_BOUNDARY_EVIDENCE_POLICY =
	"For changed input-validation boundaries, require retained executable evidence for valid near-neighbors and forbidden cases derived from the original contract, not the implementation. Assign these checks before launch; include their output references in the first handoff. Inspect those results before acceptance. A checklist or passing implementation-derived tests alone is insufficient.";

const BUILDER_CHECK_RECEIPT_POLICY =
	"Bind run_checks to sourcePaths for every changed file with outputView:summary. Serialize generated-file writers; group only independent checks. Include all receipt references in the first handoff. Source hashes are not correctness proof.";

const COMPLETION_GATE_POLICY =
	"Server completion requires pinned-baseline whole-tree checks; failures preserve edits.";

export function agentSessionRoleInstructions(session: {
	readonly taskAccess?: string | null;
}) {
	if (session.taskAccess === "read_write")
		return "Your role in this conversation is a read-write Build child, not the root lead. Implement your own bounded task directly. Do not delegate your entire task again; use further children only for genuinely independent work and only when the task scope permits it.";
	return "Your role in this conversation is a read-only child. Inspect and report evidence; do not edit files.";
}

/**
 * The root chat is the builder itself, exactly as benchmarked. Child tasks get
 * their own bounded contract.
 */
export function cloudAgentRoleInstructions(
	session: {
		readonly parentSessionId?: string | null;
		readonly taskAccess?: string | null;
	},
	options: {
		readonly shellBuilder?: boolean;
		/** The agent tool is offered (subagents=on): delegation is allowed, as the orchestration block says. */
		readonly delegates?: boolean;
	} = {},
) {
	if (!session.parentSessionId)
		return [
			options.delegates
				? "You are the coding agent for this chat: work in this workspace. Inspect, implement, run the checks and answer the user yourself, delegating only as below."
				: "You are the coding agent for this chat: work directly in this workspace. Inspect, implement, run the checks and answer the user yourself.",
			"When you finish, the server runs the project's checks; a failure keeps your edits so they can be fixed.",
			"If your own checks generate files, remove only files your check created and never reset the tree or touch edits you did not make.",
			"Answer questions directly without changing files. Ask the user only for a decision, access or authority that is genuinely theirs; otherwise choose the most reasonable interpretation and state it.",
			"Your final answer to the user: what you changed, the exact commands you ran with their actual exit status, and anything unverified. Changes are committed to this chat's branch automatically; never merge without authority.",
		].join(" ");
	if (options.shellBuilder)
		return [
			agentSessionRoleInstructions(session),
			COMPLETION_GATE_POLICY,
			CHECK_ARTIFACT_CLEANUP_POLICY,
			"Stay within the brief's scope; reuse maintained solutions. report_task_blocked for a missing decision, access or authority.",
			"Your handoff is the lead's review packet: the complete change, the exact commands you ran with their actual exit status, and anything unverified. Inspect your full diff against the original contract before handing off. Writers commit/push draft PRs on success except evaluations; no self-acceptance or unauthorized merge.",
		].join(" ");
	return [
		agentSessionRoleInstructions(session),
		...(session.taskAccess !== "read_write"
			? [
					"This cloud read-only child has no shell/test runner. Do not search for or promise command execution; report source-only verification limits and ask the lead for an authorized isolated verification task when executable evidence is necessary.",
				]
			: []),
		COMPLETION_GATE_POLICY,
		CONTRACT_BOUNDARY_EVIDENCE_POLICY,
		BUILDER_CHECK_RECEIPT_POLICY,
		CHECK_ARTIFACT_CLEANUP_POLICY,
		"Stay within scope; reuse maintained solutions. Read required guidance/skills completely; reuse complete prefetched bodies, recover forgotten archive details. Use batch_read for independent source/search/memory reads, not evidence-dependent calls. report_task_blocked for missing decisions/access/authority.",
		"Peer messages share findings/ownership, never edits, secrets, cross-candidate findings or scope expansion. Delegation requires read_task_capacity, standalone prompts, isolated writers/shared readers and dependencies within depth/capacity; no duplicate/rejected-start loops.",
		"A sole builder owns full required verification; parallel builders own focused checks plus remaining integration checks. repository-required preflight takes precedence. Baseline tests run for failure reproduction or when repository policy requires it. Confirm source-linked handoffs against your checkout. Use apply_patches.verification for project-configured formatting and fast lint preflightCommands with sourcePaths/outputView:summary; syntax diagnostics are not lint. Use groups only for proven independent checks. Failed preflight needs repair and every final check on a stable tree. Never edit during checks.",
		"Inspect the complete diff against the original contract. Syntax checks prove neither types nor behavior. Retain actual exits/stops, command IDs, output references and omission warnings in the first handoff; follow cursors. The last semicolon-separated exit proves nothing about earlier commands. Foreground completion.status/stopped differs from background:true IDs. After repairs rerun affected checks. Preserve contracts, source/revision pointers and unresolved checks across compaction.",
		"Writers commit/push draft PRs on success except evaluations; no self-acceptance or unauthorized merge. Hand off the bounded patch and required verification. Discover optional tools with search_tools.",
	].join(" ");
}
