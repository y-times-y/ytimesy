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
	sessionTitleFromItems,
	sessionViewItems,
} from "#/domain/session-item";
import {
	type AgentSessionRecord,
	listAgentSessions,
	saveAgentSessionItems,
	saveAgentSessionTurnStatus,
} from "#/server/adapters/agent-sessions";
import {
	insertProjectTrace,
	loadProjectBriefing,
	saveProjectBriefing,
} from "#/server/adapters/project-context";
import type { PublicCodexSession } from "./codex-workspace-session";

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
	const liveItems = sessionViewItems(
		view.items,
		sessionItemsFromUnknown(session.items),
	);
	const title = sessionTitleFromItems(liveItems);
	const submittedModelId = view.listedModelId.trim() || session.listedModelId;
	const persistTurn = sessionTurnStatusForPersist({
		liveStatus: view.turnStatus,
		liveConnection: view.connection.status,
	});
	const previous = sessionItemsFromUnknown(session.items);
	const saved = await saveAgentSessionItems(
		session.id,
		liveItems,
		title === "New session" ? undefined : title,
		view.listedModelId.trim() || null,
		persistTurn,
	);
	const turnStatus = saved?.turnStatus ?? persistTurn ?? session.turnStatus;
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
