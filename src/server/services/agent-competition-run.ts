import { Effect } from "effect";
import { competitionCandidateInstructions } from "#/domain/agent-competition";
import {
	competitionCandidate,
	competitionCandidateIds,
	competitionForOwner,
	competitionRuntime,
	markCompetitionStatus,
} from "../adapters/agent-competitions";
import {
	agentSessionForOwner,
	descendantAgentSessions,
	saveAgentTaskState,
} from "../adapters/agent-sessions";
import { saveAgentTaskResultAndEvent } from "../adapters/agent-task-events";
import { enqueueAgentTaskEvent } from "../jobs/queue";
import { openAgentTask } from "./agent-session-machine";
import {
	startPreparedAgentTask,
	stopHarnessWorkspaceTurn,
} from "./harness-workspace-session";

/** A retry reuses its numbered candidate instead of copying another machine. */
export async function startAgentCompetition(rootSessionId: string) {
	const group = await competitionRuntime(rootSessionId);
	if (
		!group ||
		group.status === "complete" ||
		group.status === "failed" ||
		group.status === "judging"
	)
		return;
	await markCompetitionStatus(rootSessionId, "working");
	for (let index = 1; index <= group.leader_count; index += 1) {
		if ((await competitionRuntime(rootSessionId))?.status !== "working") break;
		let candidate = await competitionCandidate(group.user_id, group.id, index);
		if (!candidate) {
			const opened = await openAgentTask({
				userId: group.user_id,
				projectId: group.project_id,
				parentSessionId: rootSessionId,
				candidateIndex: index,
				competitionId: group.id,
				title: `Agent ${index}`,
				harness: group.harness,
				modelId: group.attempt_model_ids?.[index - 1] ?? group.model_id,
				prompt: `${group.prompt}\n\n${competitionCandidateInstructions}`,
				placement: "fresh",
				access: "read_write",
				execution: "parallel",
				dependsOnSessionId: null,
			});
			candidate = { id: opened.id, taskState: opened.taskState ?? "draft" };
		}
		if (!candidate) throw new Error("Agent candidate could not be created.");
		if ((await competitionRuntime(rootSessionId))?.status !== "working") break;
		if (candidate.taskState !== "draft" && candidate.taskState !== "idle")
			continue;
		try {
			await Effect.runPromise(
				startPreparedAgentTask(
					{
						userId: group.user_id,
						projectId: group.project_id,
						sessionId: rootSessionId,
						harnessId: group.harness,
						createNew: false,
					},
					candidate.id,
				),
			);
		} catch (error) {
			await saveAgentTaskState(candidate.id, "failed");
			const eventId = await saveAgentTaskResultAndEvent({
				sessionId: candidate.id,
				eventType: "failed",
				summary:
					error instanceof Error ? error.message : "Agent could not start.",
			});
			if (eventId) await enqueueAgentTaskEvent(eventId).catch(() => null);
		}
	}
}

export async function stopAgentCompetitionRun(
	userId: string,
	rootSessionId: string,
) {
	const group = await competitionForOwner(userId, rootSessionId);
	if (!group || group.status === "complete" || group.status === "failed")
		return group;
	const root = await agentSessionForOwner(userId, rootSessionId);
	if (!root) throw new Error("This chat is no longer available.");
	await markCompetitionStatus(root.id, "failed", "Stopped by user.");
	const candidateIds = await competitionCandidateIds(group.id);
	const candidates = (await descendantAgentSessions(userId, root.id)).filter(
		(candidate) =>
			candidate.parentSessionId === root.id && candidateIds.has(candidate.id),
	);
	for (const candidate of candidates) {
		if (candidate.taskState === "done" || candidate.taskState === "failed")
			continue;
		if (
			candidate.taskState === "working" ||
			candidate.taskState === "waiting"
		) {
			await Effect.runPromise(
				stopHarnessWorkspaceTurn({
					userId,
					projectId: root.projectId,
					sessionId: candidate.id,
					harnessId: candidate.harness,
					createNew: false,
				}),
			).catch(() => undefined);
		}
		await saveAgentTaskState(candidate.id, "failed");
	}
	if (group.status === "judging")
		await Effect.runPromise(
			stopHarnessWorkspaceTurn({
				userId,
				projectId: root.projectId,
				sessionId: root.id,
				harnessId: root.harness,
				createNew: false,
			}),
		).catch(() => undefined);
	return competitionForOwner(userId, root.id);
}
