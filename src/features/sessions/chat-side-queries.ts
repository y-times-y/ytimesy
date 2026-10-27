import type { SessionTurnStatus } from "#/domain/session-item";

/**
 * Query keys of the open chat's side reads (helpers, background commands,
 * evidence, recovery points). One place, because the page seeds these queries with what the
 * server read alongside the chat (OpenChatSide) and the views read them.
 */
export const chatSideKeys = {
	tasks: (projectId: string | undefined, sessionId: string | undefined) =>
		["agent-tasks", projectId, sessionId] as const,
	background: (sessionId: string | undefined, chatIds: readonly string[]) =>
		["background-commands", sessionId, chatIds] as const,
	evidence: (
		projectId: string | undefined,
		sessionId: string | null | undefined,
		turnStatus: SessionTurnStatus,
	) => ["chat-evidence", projectId, sessionId, turnStatus] as const,
	recoveryPoints: (
		projectId: string | undefined,
		sessionId: string | null | undefined,
		itemCount: number,
		turnStatus: SessionTurnStatus,
	) =>
		[
			"conversation-recovery",
			projectId,
			sessionId,
			itemCount,
			turnStatus,
		] as const,
};
