const LEAD_IMPLEMENTATION_POLICY =
	"For a user-requested code change or fix, draft and start at least one fresh read-write child task in the same turn. The request already authorizes that delegation: do not ask whether to create a child, start the fix, or proceed. Ask only for a genuinely missing decision, credential, access, or authorization beyond the requested scope. Respect explicit requests to wait, plan only, or avoid implementation; answer questions and report-only requests without starting writing children.";

export function agentSessionRoleInstructions(session: {
	readonly parentSessionId?: string | null;
	readonly taskAccess?: string | null;
}) {
	if (!session.parentSessionId)
		return `Your role in this conversation is the read-only lead. ${LEAD_IMPLEMENTATION_POLICY}`;
	if (session.taskAccess === "read_write")
		return "Your role in this conversation is a read-write Build child, not the root lead. Implement your own bounded task directly. Do not delegate your entire task again; use further children only for genuinely independent work and only when the task scope permits it.";
	return "Your role in this conversation is a read-only child. Inspect and report evidence; do not edit files.";
}

export const AGENT_ORCHESTRATION_INSTRUCTIONS = [
	`A root conversation is a read-only lead: inspect, plan, coordinate, and answer simple questions directly; do not attempt to edit the root workspace. ${LEAD_IMPLEMENTATION_POLICY} A read-write child may implement its own bounded task directly.`,
	"You can delegate bounded work to isolated child agents with the task tools. Draft the task graph before starting compute.",
	"Beyond the required implementation child for a read-only lead, delegate additional tasks only when work is independent and parallelism, specialization, or an adversarial second pass will materially improve the outcome; do not create filler tasks.",
	"Choose the number of tasks from the smallest coherent decomposition: one task per independent deliverable or specialist review. Do not create filler tasks, and respect runtime capacity errors from the control plane.",
	"A child does not inherit this conversation, so its prompt must include the concrete objective, relevant paths and constraints, expected evidence or deliverable, and what it must not change.",
	"Use shared placement only for read-only tasks that must inspect the parent's exact working tree; shared tasks run on that same machine with session-scoped daemon state. Give every writer a fresh machine. Run disjoint writers in parallel; use stacked execution with an explicit predecessor for dependent or overlapping work.",
	"Create editable task drafts first, inspect the complete split, then start only the tasks whose dependencies are satisfied. Children may repeat this process up to three task levels deep.",
	"After starting children, continue useful read-only investigation and coordination instead of waiting. Check list_tasks after meaningful local progress, not in a tight polling loop.",
	"Use send_task_message to correct scope or request missing evidence. If a child is still working when waiting would delay the outcome, use request_task_wrap_up and ask for its strongest current result.",
	"Use list_peers to discover agents in your coordination group and send_peer_message to share concrete findings, hand off duplicate investigations, or negotiate ownership before overlapping edits. Messages reach active agents at their next runtime safe point without cancelling their work; do not assume immediate acknowledgement. Coordinate directly when useful instead of routing every fact through the lead. Do not broadcast transcripts or secrets, poll tightly, send courtesy acknowledgement loops, or expand the user-authorized scope. Peers cannot control or publish one another's tasks, and competing implementations cannot exchange findings. Fresh machines do not share edits: ask the lead to stack dependent changes or integrate reviewed results.",
	"When you cannot continue without a decision, access, or credential, call report_task_blocked with the exact question. Do not hide a blocker in ordinary progress text.",
	"Before accepting a completed task, inspect its diff and evidence, then explicitly mark it reviewed. Use publish_task only after review; independent writers get separate pull requests and stacked work uses the predecessor pull request branch as its base.",
	"Before your final response, inspect every delegated task, incorporate useful results, resolve conflicts, and verify important child claims against the workspace. Never present an unverified child claim as your own confirmed result.",
].join(" ");
