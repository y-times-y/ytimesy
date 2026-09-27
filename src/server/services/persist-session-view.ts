import { sessionTurnStatusForPersist } from "#/domain/agent-session";
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
import { enqueueAgentTaskEvent } from "#/server/jobs/queue";
import type { PublicCodexSession } from "./codex-workspace-session";

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
	if (
		view.connection.status === "authenticated" &&
		view.connection.provider === session.harness
	) {
		await saveAgentModelCatalog(session.userId, session.harness, view.models);
	}
	let liveItems = sessionViewItems(
		view.items,
		sessionItemsFromUnknown(stored.items),
	);
	const title = sessionTitleFromItems(liveItems);
	const submittedModelId = view.listedModelId.trim() || stored.listedModelId;
	const persistTurn = sessionTurnStatusForPersist({
		liveStatus: view.turnStatus,
		liveConnection: view.connection.status,
		storedStatus: stored.turnStatus,
		storedLastUser: lastUserMessageText(sessionItemsFromUnknown(stored.items)),
		liveLastUser: lastUserMessageText(view.items),
	});
	const previous = sessionItemsFromUnknown(stored.items);
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
	await saveAgentSessionTurnStatus(session.id, turnStatus);
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
