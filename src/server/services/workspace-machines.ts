import type { WorkspaceId } from "#/domain/ids";

export interface CommandOutput {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}

export interface ProofWorkspace {
	readonly workspaceId: WorkspaceId;
	readonly state: string;
	readonly slug: string;
}

export interface WorkspaceMachines {
	readonly createProofWorkspace: () => Promise<ProofWorkspace>;
	readonly exec: (
		workspaceId: WorkspaceId,
		command: string,
		timeoutMs?: number,
	) => Promise<CommandOutput>;
	readonly writeTextFile: (
		workspaceId: WorkspaceId,
		path: string,
		contents: string,
	) => Promise<void>;
	readonly destroy: (workspaceId: WorkspaceId) => Promise<void>;
	readonly destroyOrphans: (slugPrefix: string) => Promise<readonly string[]>;
}
