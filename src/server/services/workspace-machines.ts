import type { IsolatedAuthSnapshot } from "#/domain/auth-snapshot";
import type { AuthSnapshotId, WorkspaceId } from "#/domain/ids";

export interface CommandOutput {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}

export interface ProofWorkspace {
	readonly workspaceId: WorkspaceId;
	readonly state: string;
	readonly slug: string;
	readonly bootedFromSnapshotId: string | null;
}

export interface CreateProofWorkspaceOptions {
	readonly ttlSeconds?: number;
	readonly idleTimeoutSeconds?: number;
	readonly snapshotId?: string;
}

export interface WorkspaceMachines {
	readonly createProofWorkspace: (
		options?: CreateProofWorkspaceOptions,
	) => Promise<ProofWorkspace>;
	readonly snapshotAuthenticatedWorkspace: (
		workspaceId: WorkspaceId,
	) => Promise<IsolatedAuthSnapshot>;
	readonly destroySnapshot: (snapshotId: AuthSnapshotId) => Promise<void>;
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
	readonly readTextFile: (
		workspaceId: WorkspaceId,
		path: string,
	) => Promise<string | null>;
	readonly destroy: (workspaceId: WorkspaceId) => Promise<void>;
	readonly exposeHttp: (
		workspaceId: WorkspaceId,
		port: number,
		hostname: string,
	) => Promise<string>;
	readonly destroyOrphans: (slugPrefix: string) => Promise<readonly string[]>;
}
