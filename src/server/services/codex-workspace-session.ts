import type { AgentConnection } from "#/domain/agent-connection";
import type { CodexUsage } from "#/domain/codex-usage";
import type { ListedModel } from "#/domain/listed-model";
import type { SessionItem, SessionTurnStatus } from "#/domain/session-item";

export type PublicCodexSession = {
	readonly usage?: CodexUsage;
	readonly snapshotAvailable: boolean;
	readonly workspaceId: string | null;
	readonly agentSessionId: string | null;
	readonly selectedBranch?: string | null;
	readonly connection: AgentConnection;
	readonly models: readonly ListedModel[];
	readonly listedModelId: string;
	readonly blockedListedModelIds: readonly string[];
	readonly canSend: boolean;
	readonly turnStatus: SessionTurnStatus;
	readonly items: readonly SessionItem[];
};

export type CodexSessionScope = {
	readonly userId: string;
	readonly projectId?: string;
	readonly sessionId?: string;
	readonly createNew?: boolean;
};

const disconnected: AgentConnection = { status: "disconnected" };

export function emptyCodexSession(
	snapshotAvailable = false,
): PublicCodexSession {
	return {
		snapshotAvailable,
		workspaceId: null,
		agentSessionId: null,
		connection: disconnected,
		models: [],
		listedModelId: "",
		blockedListedModelIds: [],
		canSend: false,
		turnStatus: "idle",
		items: [],
	};
}
