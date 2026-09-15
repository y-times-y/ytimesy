import { traceSummaryFromTurn } from "#/domain/project-context";
import {
	lastAgentMessageText,
	lastUserMessageText,
	sessionItemsFromUnknown,
	sessionTitleFromItems,
	type SessionItem,
} from "#/domain/session-item";
import {
	type AgentSessionRecord,
	saveAgentSessionItems,
} from "#/server/adapters/agent-sessions";
import { insertProjectTrace } from "#/server/adapters/project-context";
import type { PublicCodexSession } from "./codex-workspace-session";

export async function persistBoundSessionView(
	session: AgentSessionRecord | null,
	view: PublicCodexSession,
): Promise<PublicCodexSession> {
	if (!session) return { ...view, agentSessionId: null };
	const liveItems = view.items.length
		? view.items
		: sessionItemsFromUnknown(session.items);
	const title = sessionTitleFromItems(liveItems);
	if (liveItems.length > 0) {
		const previous = sessionItemsFromUnknown(session.items);
		await saveAgentSessionItems(
			session.id,
			liveItems,
			title === "New session" ? undefined : title,
		);
		if (view.turnStatus !== "running") {
			await captureTurnTrace(session, previous, liveItems);
		}
	}
	return {
		...view,
		agentSessionId: session.id,
		items: liveItems,
	};
}

async function captureTurnTrace(
	session: AgentSessionRecord,
	previous: readonly SessionItem[],
	next: readonly SessionItem[],
) {
	const reply = lastAgentMessageText(next);
	if (!reply || reply === lastAgentMessageText(previous)) return;
	const summary = traceSummaryFromTurn({
		task: lastUserMessageText(next) ?? session.title,
		reply,
	});
	if (!summary) return;
	await insertProjectTrace({
		projectId: session.projectId,
		sessionId: session.id,
		area: null,
		summary,
	});
}
