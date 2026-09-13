import { type AgentConnection, canStartAgentTurn } from "./agent-connection";
import { isUsableWorkspace, type WorkspaceLifecycle } from "./workspace";

export function canSendSessionTask(
	workspace: WorkspaceLifecycle,
	connection: AgentConnection,
): boolean {
	return isUsableWorkspace(workspace) && canStartAgentTurn(connection);
}
