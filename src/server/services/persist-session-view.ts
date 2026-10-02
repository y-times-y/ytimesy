import {
	competitionCandidatePublicItems,
	competitionPublicItems,
} from "#/domain/agent-competition";
import { sessionTurnStatusForPersist } from "#/domain/agent-session";
import { childTaskPublicItems } from "#/domain/child-task-activity";
import { listedModelPreferenceFromSessions } from "#/domain/listed-model";
import {
	briefingUpdateFromTurn,
	completedTurnUpdatesProjectContext,
	nextProjectBriefing,
	traceAreaFromTurn,
	traceSummaryFromTurn,
} from "#/domain/project-context";
import {
	lastAgentMessageText,
	lastUserMessageText,
	reasoningSummariesFromTurn,
	type SessionItem,
	type SessionTurnStatus,
	sessionItemsFromUnknown,
	sessionItemsQueuedWithUser,
	sessionTitleFromItems,
	sessionViewItems,
} from "#/domain/session-item";
import { recordTurnTiming } from "#/domain/turn-timing";
import { competitionForCandidate } from "#/server/adapters/agent-competitions";
import { saveAgentModelCatalog } from "#/server/adapters/agent-model-catalog";
import {
	type AgentSessionRecord,
	agentSessionById,
	listAgentSessions,
	saveAgentSessionItems,
	saveAgentSessionTurnStatus,
} from "#/server/adapters/agent-sessions";
import { saveAgentTaskResultAndEvent } from "#/server/adapters/agent-task-events";
import {
	insertProjectTrace,
	loadProjectBriefing,
	saveProjectBriefing,
} from "#/server/adapters/project-context";
import {
	enqueueAgentTaskEvent,
	enqueueSessionCheckpoint,
} from "#/server/jobs/queue";
import type { PublicCodexSession } from "./codex-workspace-session";
import { captureTurnTransition } from "./turn-analytics";

export async function persistQueuedUserTurn(
	session: AgentSessionRecord | null,
	view: PublicCodexSession,
	text: string,
): Promise<PublicCodexSession> {
	return persistBoundSessionView(session, {
		...view,
		turnStatus: "running",
		items: recordTurnTiming(
			sessionItemsQueuedWithUser(sessionItemsFromUnknown(session?.items), text),
			"running",
			Date.now(),
			true,
		),
		canSend: false,
	});
}

export async function persistBoundSessionView(
	session: AgentSessionRecord | null,
	view: PublicCodexSession,
): Promise<PublicCodexSession> {
	if (!session) {
		return {
			...view,
			agentSessionId: null,
			listedModelId: view.listedModelId,
			blockedListedModelIds: view.blockedListedModelIds,
		};
	}
	const stored = (await agentSessionById(session.id)) ?? session;
	view = {
		...view,
		selectedBranch:
			stored.selectedBranch ?? stored.workingBranch ?? stored.taskBranch,
	};
	const competition =
		stored.candidateIndex && stored.parentSessionId
			? await competitionForCandidate(stored.userId, stored.id)
			: null;
	const publicItems = (items: readonly SessionItem[]) =>
		childTaskPublicItems(
			competition
				? competitionCandidatePublicItems(items, competition.prompt)
				: competitionPublicItems(items),
		);
	const recordedItems = publicItems(sessionItemsFromUnknown(stored.items));
	const providerItems = publicItems(view.items);
	if (
		view.connection.status === "authenticated" &&
		view.connection.provider === session.harness
	) {
		await saveAgentModelCatalog(session.userId, session.harness, view.models);
	}
	let liveItems = sessionViewItems(providerItems, recordedItems);
	const title = stored.parentSessionId
		? undefined
		: sessionTitleFromItems(liveItems);
	const submittedModelId = view.listedModelId.trim() || stored.listedModelId;
	const persistTurn = sessionTurnStatusForPersist({
		liveStatus: view.turnStatus,
		liveConnection: view.connection.status,
		storedStatus: stored.turnStatus,
		storedLastUser: lastUserMessageText(recordedItems),
		liveLastUser: lastUserMessageText(providerItems),
	});
	const previous = recordedItems;
	liveItems = recordTurnTiming(
		liveItems,
		persistTurn ?? stored.turnStatus,
		Date.now(),
	);
	const saved = await saveAgentSessionItems(
		session.id,
		liveItems,
		title === "New session" ? undefined : title,
		submittedModelId?.trim() || session.listedModelId || null,
		persistTurn,
	);
	const turnStatus = saved?.turnStatus ?? persistTurn ?? session.turnStatus;
	if (saved) captureTurnTransition(stored, turnStatus, liveItems);
	if (
		process.env.SUPABASE_STORAGE_SERVICE_KEY &&
		stored.turnStatus === "running" &&
		(turnStatus === "completed" || turnStatus === "failed")
	) {
		await enqueueSessionCheckpoint(session.userId, session.id);
	}
	if (
		session.parentSessionId &&
		(turnStatus === "completed" || turnStatus === "failed")
	) {
		const summary = lastAgentMessageText(liveItems);
		if (summary) {
			const eventId = await saveAgentTaskResultAndEvent({
				sessionId: session.id,
				summary,
				eventType: turnStatus === "failed" ? "failed" : "completed",
			});
			if (eventId) void enqueueAgentTaskEvent(eventId).catch(() => undefined);
		}
	}
	if (liveItems.length > 0 && turnStatus !== "running") {
		await captureTurnTrace(session, previous, liveItems);
	}
	const siblings = await listAgentSessions(session.userId, session.projectId);
	const preference = listedModelPreferenceFromSessions({
		harness: session.harness,
		sessions: [
			{
				harness: session.harness,
				listedModelId: submittedModelId,
				items: liveItems,
			},
			...siblings
				.filter((row) => row.id !== session.id)
				.map((row) => ({
					harness: row.harness,
					listedModelId: row.listedModelId,
					items: row.items,
				})),
		],
	});
	return {
		...view,
		agentSessionId: session.id,
		items: liveItems,
		turnStatus,
		listedModelId: preference.listedModelId,
		blockedListedModelIds: preference.blockedListedModelIds,
	};
}

export async function persistSessionTurnStatus(
	session: AgentSessionRecord | null,
	turnStatus: SessionTurnStatus,
): Promise<void> {
	if (!session) return;
	const stored = (await agentSessionById(session.id)) ?? session;
	const saved = await saveAgentSessionTurnStatus(session.id, turnStatus);
	if (saved) captureTurnTransition(stored, turnStatus, saved.items);
}

async function captureTurnTrace(
	session: AgentSessionRecord,
	previous: readonly SessionItem[],
	next: readonly SessionItem[],
) {
	const reply = lastAgentMessageText(next);
	if (!reply || reply === lastAgentMessageText(previous)) return;
	const task = lastUserMessageText(next) ?? session.title;
	const area = traceAreaFromTurn({ task, items: next });
	const reasoning = reasoningSummariesFromTurn(next);
	if (
		!completedTurnUpdatesProjectContext({
			area,
			task,
			reply,
			reasoning,
		})
	) {
		return;
	}
	const summary = traceSummaryFromTurn({
		task,
		reply,
		reasoning,
	});
	if (!summary) return;
	await insertProjectTrace({
		projectId: session.projectId,
		sessionId: session.id,
		area,
		summary,
	});
	const briefing = await loadProjectBriefing(session.projectId);
	const fact = briefingUpdateFromTurn({ task, reply });
	const updated = fact
		? nextProjectBriefing({ briefing, summary: fact })
		: briefing;
	if (updated !== briefing)
		await saveProjectBriefing(session.projectId, updated);
}
