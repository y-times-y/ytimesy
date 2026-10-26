import type { RunningBackgroundCommand } from "#/domain/background-command";
import type { AgentTaskActivity } from "#/domain/child-task-activity";
import type { EvidenceRecord } from "#/domain/pr-evidence";
import { projectAgentTasksAndBackground } from "#/server/services/agent-task-activity";
import { chatEvidence } from "#/server/services/chat-evidence";
import { listConversationRecoveryPoints } from "#/server/services/conversation-recovery";

/**
 * What the open chat shows beside its items: helper lines and the agents
 * list, background commands, evidence cards and recovery rows. Read with the chat on the server, so the
 * page's first paint already has them; the browser's reads only refresh
 * them. A failed read is left out and the browser reads it as before.
 */
export type OpenChatSide = {
	readonly tasks?: readonly AgentTaskActivity[];
	/** By chat id, for the chat and the helpers backgroundReadChatIds picks from `tasks`. */
	readonly background?: Record<string, RunningBackgroundCommand[]>;
	readonly evidence?: { enabled: boolean; evidence: EvidenceRecord[] };
	readonly recoveryPoints?: readonly {
		messageId: string;
		codeAvailable: boolean;
	}[];
};

export async function openChatSide(
	userId: string,
	projectId: string,
	sessionId: string,
): Promise<OpenChatSide> {
	const [tree, evidence, recoveryPoints] = await Promise.all([
		projectAgentTasksAndBackground(userId, projectId, sessionId).catch(
			() => undefined,
		),
		chatEvidence(userId, projectId, sessionId).catch(() => undefined),
		// Only Codex and API chats show them; the read is cheap either way.
		listConversationRecoveryPoints(userId, projectId, sessionId).catch(
			() => undefined,
		),
	]);
	return {
		tasks: tree?.tasks,
		background: tree?.background,
		evidence,
		recoveryPoints,
	};
}
