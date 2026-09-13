import { type AgentConnection, canStartAgentTurn } from "./agent-connection";
import { isTurnRunning, type SessionTurnStatus } from "./session-item";
import { isUsableWorkspace, type WorkspaceLifecycle } from "./workspace";

export function canSendSessionTask(
	workspace: WorkspaceLifecycle,
	connection: AgentConnection,
): boolean {
	return isUsableWorkspace(workspace) && canStartAgentTurn(connection);
}

export function canSubmitComposer(
	workspace: WorkspaceLifecycle,
	connection: AgentConnection,
	turnStatus: SessionTurnStatus,
): boolean {
	return (
		canSendSessionTask(workspace, connection) && !isTurnRunning(turnStatus)
	);
}
