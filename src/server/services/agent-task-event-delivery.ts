import { Effect } from "effect";
import {
	competitionJudgeInstructions,
	competitionJudgeQueueText,
} from "#/domain/agent-competition";
import { childTaskEventQueueText } from "#/domain/child-task-activity";
import {
	claimCompetitionJudge,
	competitionCandidateIds,
	competitionForCandidate,
	competitionForOwner,
	markCompetitionStatus,
	recoverInterruptedCompetitionJudge,
	resetCompetitionJudge,
} from "#/server/adapters/agent-competitions";
import {
	agentSessionForOwner,
	descendantAgentSessions,
} from "#/server/adapters/agent-sessions";
import {
	type AgentTaskEvent,
	claimAgentTaskEvent,
	deferAgentTaskEvent,
	markAgentTaskEventDelivered,
} from "#/server/adapters/agent-task-events";
import { sendHarnessWorkspaceTask } from "./harness-workspace-session";
import { machinesForAgentSession } from "./session-workspace-machines";
import type { WorkspaceMachines } from "./workspace-machines";

export async function deliverAgentTaskEvents(
	machines: WorkspaceMachines,
	eventId?: string,
) {
	let delivered = 0;
	for (let count = 0; count < (eventId ? 1 : 20); count += 1) {
		const event = await claimAgentTaskEvent(eventId);
		if (!event) break;
		try {
			await deliverAgentTaskEvent(machines, event);
			await markAgentTaskEventDelivered(event.id);
			delivered += 1;
		} catch (cause) {
			const competition =
				event.attempts >= 3
					? await competitionForCandidate(event.userId, event.childSessionId)
					: null;
			if (
				competition &&
				["queued", "working", "judging"].includes(competition.status)
			) {
				await markCompetitionStatus(
					event.parentSessionId,
					"failed",
					"Comparison could not start. Agent results remain available in Tasks.",
				);
			}
			await deferAgentTaskEvent(
				event.id,
				cause instanceof Error ? cause.message : String(cause),
			);
			if (eventId) throw cause;
		}
	}
	return delivered;
}

async function deliverAgentTaskEvent(
	machines: WorkspaceMachines,
	event: AgentTaskEvent,
) {
	const [parent, child] = await Promise.all([
		agentSessionForOwner(event.userId, event.parentSessionId),
		agentSessionForOwner(event.userId, event.childSessionId),
	]);
	if (!parent || !child || parent.projectId !== child.projectId) {
		throw new Error("The task event hierarchy is no longer available.");
	}
	const competition = child.candidateIndex
		? await competitionForCandidate(event.userId, child.id)
		: null;
	if (competition) {
		if (["queued", "working", "judging"].includes(competition.status))
			await startCompetitionJudge(machines, event.userId, parent.id);
		return;
	}
	if (parent.turnStatus === "running") {
		throw new Error(
			"The parent is still working; deliver at its next idle point.",
		);
	}
	if (!parent.listedModelId) {
		throw new Error("The parent has no model selection for its wakeup turn.");
	}
	const view = await Effect.runPromise(
		sendHarnessWorkspaceTask(
			machinesForAgentSession(machines, parent),
			{
				userId: event.userId,
				projectId: parent.projectId,
				sessionId: parent.id,
				harnessId: parent.harness,
				createNew: false,
			},
			{
				modelId: parent.listedModelId,
				text: childTaskEventQueueText(event.id),
				runtimeText: `${childTaskEventQueueText(event.id)}\n${taskEventMessage(event, child.title)}\n\nThis is an internal task event, not a new user request. The child activity and result are already visible in its expandable card. Do not repeat this notification or paste its full summary into the main chat. Review the evidence and give the user only your own concise synthesis or a necessary decision question.`,
			},
		),
	);
	if (view.connection.status === "failed" || view.turnStatus === "failed") {
		throw new Error(
			view.connection.status === "failed"
				? view.connection.message
				: "The parent wakeup turn failed.",
		);
	}
}

/** The same durable judge launch can be retried without rerunning candidates. */
export async function startCompetitionJudge(
	machines: WorkspaceMachines,
	userId: string,
	rootSessionId: string,
) {
	const parent = await agentSessionForOwner(userId, rootSessionId);
	if (
		!parent ||
		parent.parentSessionId ||
		!(await competitionForOwner(userId, parent.id))
	)
		throw new Error("The comparison chat is not available.");
	await recoverInterruptedCompetitionJudge(userId, parent.id);
	const claimed = await claimCompetitionJudge(userId, parent.id);
	if (!claimed) return false;
	try {
		const candidateIds = await competitionCandidateIds(claimed.id);
		const candidates = (await descendantAgentSessions(userId, parent.id))
			.filter(
				(task) => task.parentSessionId === parent.id && task.candidateIndex,
			)
			.filter((task) => candidateIds.has(task.id))
			.sort(
				(left, right) =>
					(left.candidateIndex ?? 0) - (right.candidateIndex ?? 0),
			);
		const evidence = candidates
			.map(
				(task) =>
					`Agent ${task.candidateIndex} (${task.id}): ${task.taskState}. Summary: ${task.taskSummary || "No summary."}`,
			)
			.join("\n\n");
		const view = await Effect.runPromise(
			sendHarnessWorkspaceTask(
				machinesForAgentSession(machines, parent),
				{
					userId,
					projectId: parent.projectId,
					sessionId: parent.id,
					harnessId: parent.harness,
					createNew: false,
				},
				{
					modelId: parent.listedModelId || "",
					text: competitionJudgeQueueText,
					runtimeText: `Compare independent implementations for: ${claimed.prompt}\n\n${evidence}\n\n${competitionJudgeInstructions}`,
				},
			),
		);
		if (view.connection.status === "failed" || view.turnStatus === "failed")
			throw new Error("The comparison turn could not start.");
	} catch (error) {
		await resetCompetitionJudge(parent.id);
		throw error;
	}
	return true;
}

export function taskEventMessage(event: AgentTaskEvent, childTitle: string) {
	const label = childTitle.trim() || "Child task";
	if (event.eventType === "blocked") {
		return `${label} is blocked and needs your decision:\n\n${event.payload.message}\n\nAnswer the child, escalate to the user if necessary, or revise the plan.`;
	}
	const outcome = event.eventType === "failed" ? "failed" : "finished";
	return `${label} ${outcome}. Its final summary is below:\n\n${event.payload.message}\n\nInspect its evidence and diff before accepting or publishing the result.`;
}
