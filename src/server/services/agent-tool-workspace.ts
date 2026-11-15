import type { WorkspaceId } from "#/domain/ids";
import type { WorkspaceMachines } from "./workspace-machines";

export type AgentToolWorkspace = {
	machines: WorkspaceMachines;
	vm: WorkspaceId;
	cwd: string;
	/** Set when this chat's machine was replaced (the VM it replaced): the agent is told once. */
	replacedFrom?: string;
};
export type AgentToolWorkspaceInput =
	| AgentToolWorkspace
	| { workspace: () => Promise<AgentToolWorkspace> };
export function resolveToolWorkspace(
	input: AgentToolWorkspaceInput,
): Promise<AgentToolWorkspace> {
	return "workspace" in input ? input.workspace() : Promise.resolve(input);
}
