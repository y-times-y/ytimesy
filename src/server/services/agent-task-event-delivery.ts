import { Effect } from "effect";
import {
	competitionJudgeInstructions,
	competitionJudgeQueueText,
} from "#/domain/agent-competition";
import { childTaskEventQueueText } from "#/domain/child-task-activity";
import { WorkspaceId } from "#/domain/ids";
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
	type AgentSessionRecord,
	agentSessionForOwner,
	descendantAgentSessions,
} from "#/server/adapters/agent-sessions";
import {
	type AgentTaskEvent,
	claimAgentTaskEvent,
	deferAgentTaskEvent,
	markAgentTaskEventDelivered,
} from "#/server/adapters/agent-task-events";
import {
	acknowledgeServerPeerMessage,
	removePendingServerPeerMessage,
	serverPeerMessageAccepted,
	stageServerPeerMessage,
} from "#/server/adapters/server-peer-inbox";
import { sendHarnessWorkspaceTask } from "./harness-workspace-session";
import {
	PEER_INBOX_PATH,
	peerMessageAccepted,
	stagePeerMessage,
} from "./peer-inbox";
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
	await deliverParentTaskNotification(
		machines,
		parent,
		event.id,
		`${childTaskEventQueueText(event.id)}\nThis is an internal task event, not a new user request. The child activity and result are already visible in its expandable card. Do not repeat this notification or paste its full summary into the main chat. Review the evidence and give the user only your own concise synthesis or a necessary decision question.\n\n${taskEventMessage(event, child.title, !parent.parentSessionId && parent.candidateIndex == null && (parent.harness === "api" || parent.harness === "codex"))}`,
	);
}

/** Active turns consume the existing mailbox at safe points; idle turns wake normally. */
export async function deliverParentTaskNotification(
	machines: WorkspaceMachines,
	parent: AgentSessionRecord,
	notificationId: string,
	runtimeText: string,
) {
	runtimeText =
		runtimeText.length > 11000
			? `${runtimeText.slice(0, 10500)}\n[Notification excerpt truncated. Read the child's full result with read_task before reviewing.]`
			: runtimeText;
	const serverHarness = parent.harness === "api" || parent.harness === "codex";
	const scopedMachines = machinesForAgentSession(machines, parent);
	if (await serverPeerMessageAccepted(parent.id, notificationId)) return;
	if (
		!serverHarness &&
		parent.providerRef &&
		(await peerMessageAccepted(
			scopedMachines,
			WorkspaceId(parent.providerRef),
			notificationId,
		))
	)
		return;
	if (parent.turnStatus === "running") {
		if (serverHarness)
			await stageServerPeerMessage(parent.id, notificationId, runtimeText);
		else {
			if (!parent.providerRef)
				throw new Error("The parent runtime is unavailable.");
			await stagePeerMessage(
				scopedMachines,
				WorkspaceId(parent.providerRef),
				notificationId,
				runtimeText,
				parent.id,
			);
		}
		throw new Error(
			"Task notification awaits the parent's next model safe point.",
		);
	}
	if (serverHarness)
		await removePendingServerPeerMessage(parent.id, notificationId);
	else if (parent.providerRef) {
		if (!/^[a-zA-Z0-9-]+$/.test(notificationId))
			throw new Error("Invalid task notification ID.");
		const removed = await scopedMachines.exec(
			WorkspaceId(parent.providerRef),
			`rm -f ${PEER_INBOX_PATH}/${notificationId}.json`,
			10_000,
		);
		if (removed.exitCode !== 0)
			throw new Error("The parent mailbox is unavailable.");
	}
	if (!parent.listedModelId) {
		throw new Error("The parent has no model selection for its wakeup turn.");
	}
	const view = await Effect.runPromise(
		sendHarnessWorkspaceTask(
			scopedMachines,
			{
				userId: parent.userId,
				projectId: parent.projectId,
				sessionId: parent.id,
				harnessId: parent.harness,
				createNew: false,
			},
			{
				modelId: parent.listedModelId,
				text: childTaskEventQueueText(notificationId),
				runtimeText,
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
	await stageServerPeerMessage(parent.id, notificationId, runtimeText);
	await acknowledgeServerPeerMessage(parent.id, notificationId);
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

export function taskEventMessage(
	event: AgentTaskEvent,
	childTitle: string,
	automaticReview = false,
) {
	const label = childTitle.trim() || "Child task";
	if (event.eventType === "blocked") {
		return `${label} is blocked and needs your decision:\n\n${event.payload.message}\n\nAnswer the child, escalate to the user if necessary, or revise the plan.`;
	}
	if (automaticReview && event.eventType === "completed")
		return `${label} (${event.childSessionId}) finished. The server collects its review packet at your next model step. Inspect that evidence against the original contract; missing evidence requires read_task_handoff. Completion is not acceptance. The full summary remains available in the child card and read_task_summary.`;
	const outcome = event.eventType === "failed" ? "failed" : "finished";
	return `${label} ${outcome}. Its final summary is below:\n\n${event.payload.message}\n\nInspect its evidence and diff before accepting or publishing the result.`;
}
