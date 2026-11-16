import type { AgentProviderId } from "#/domain/agent-provider";
import type { RunningBackgroundCommand } from "#/domain/background-command";
import type { AgentTaskActivity } from "#/domain/child-task-activity";
import type { ListedModel } from "#/domain/listed-model";
import { projectAgentTasksAndBackground } from "#/server/services/agent-task-activity";
import { listConversationRecoveryPoints } from "#/server/services/conversation-recovery";

/**
 * What the open chat shows beside its items: helper lines and the agents
 * list, background commands and recovery rows. Read with the chat on the server, so the
 * page's first paint already has them; the browser's reads only refresh
 * them. A failed read is left out and the browser reads it as before.
 */
export type OpenChatSide = {
	readonly tasks?: readonly AgentTaskActivity[];
	/** By chat id, for the chat and the helpers backgroundReadChatIds picks from `tasks`. */
	readonly background?: Record<string, RunningBackgroundCommand[]>;
	readonly recoveryPoints?: readonly {
		messageId: string;
		codeAvailable: boolean;
		/** False while forking is off; absent from a server before this field. */
		forkAvailable?: boolean;
	}[];
	/**
	 * The composer's model list for the chat's runtime when the chat's view
	 * has none (Codex signed out): the browser's catalog read, so the model
	 * button shows the model's name from the first paint, not its id.
	 */
	readonly catalog?: {
		readonly harnessId: AgentProviderId;
		readonly models: readonly ListedModel[];
	};
};

export async function openChatSide(
	userId: string,
	projectId: string,
	sessionId: string,
): Promise<OpenChatSide> {
	const [tree, recoveryPoints] = await Promise.all([
		// The page applies deltas (their positions come with the first read).
		projectAgentTasksAndBackground(
			userId,
			projectId,
			sessionId,
			{},
			{
				deltas: true,
			},
		).catch(() => undefined),
		// Only Codex and API chats show them; the read is cheap either way.
		listConversationRecoveryPoints(userId, projectId, sessionId).catch(
			() => undefined,
		),
	]);
	return {
		tasks: tree?.tasks,
		background: tree?.background,
		recoveryPoints,
	};
}
