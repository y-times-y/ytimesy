import { Effect } from "effect";
import { agentSessionForOwner } from "#/server/adapters/agent-sessions";
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
				text: taskEventMessage(event, child.title),
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

export function taskEventMessage(event: AgentTaskEvent, childTitle: string) {
	const label = childTitle.trim() || "Child task";
	if (event.eventType === "blocked") {
		return `${label} is blocked and needs your decision:\n\n${event.payload.message}\n\nAnswer the child, escalate to the user if necessary, or revise the plan.`;
	}
	const outcome = event.eventType === "failed" ? "failed" : "finished";
	return `${label} ${outcome}. Its final summary is below:\n\n${event.payload.message}\n\nInspect its evidence and diff before accepting or publishing the result.`;
}
