import { listedModelPreferenceFromSessions } from "#/domain/listed-model";
import {
	briefingUpdateFromTurn,
	nextProjectBriefing,
	traceSummaryFromTurn,
} from "#/domain/project-context";
import {
	lastAgentMessageText,
	lastUserMessageText,
	reasoningSummariesFromTurn,
	type SessionItem,
	sessionItemsFromUnknown,
	sessionTitleFromItems,
	sessionViewItems,
} from "#/domain/session-item";
import {
	type AgentSessionRecord,
	listAgentSessions,
	saveAgentSessionItems,
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
	if (liveItems.length > 0) {
		const previous = sessionItemsFromUnknown(session.items);
		await saveAgentSessionItems(
			session.id,
			liveItems,
			title === "New session" ? undefined : title,
			view.listedModelId.trim() || null,
		);
		if (view.turnStatus !== "running") {
			await captureTurnTrace(session, previous, liveItems);
		}
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
		listedModelId: preference.listedModelId,
		blockedListedModelIds: preference.blockedListedModelIds,
	};
}

async function captureTurnTrace(
	session: AgentSessionRecord,
	previous: readonly SessionItem[],
	next: readonly SessionItem[],
) {
	const reply = lastAgentMessageText(next);
	if (!reply || reply === lastAgentMessageText(previous)) return;
	const task = lastUserMessageText(next) ?? session.title;
	const summary = traceSummaryFromTurn({
		task,
		reply,
		reasoning: reasoningSummariesFromTurn(next),
	});
	if (!summary) return;
	await insertProjectTrace({
		projectId: session.projectId,
		sessionId: session.id,
		area: null,
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
