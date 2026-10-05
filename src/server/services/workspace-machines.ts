import type { IsolatedAuthSnapshot } from "#/domain/auth-snapshot";
import type { AuthSnapshotId, WorkspaceId } from "#/domain/ids";
import type { MachineSizeId } from "#/domain/machine-size";

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
	readonly restoreRetainedSession?: (
		userId: string,
		sessionId: string,
		oldVmId: string,
	) => Promise<string | null>;
	readonly destroyCodexSession?: (
		userId: string,
		sessionId: string,
	) => Promise<void>;
	readonly codexRuntime?: (input: {
		readonly userId: string;
		readonly sessionId: string;
		readonly executorId: WorkspaceId;
		readonly executorMachines: WorkspaceMachines;
		readonly provision: boolean;
	}) => Promise<CodexRuntime | null>;
	readonly createProofWorkspace: (
		options?: CreateProofWorkspaceOptions,
	) => Promise<ProofWorkspace>;
	readonly snapshotAuthenticatedWorkspace: (
		workspaceId: WorkspaceId,
		provider?: "codex" | "claude",
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
	readonly ensureRunning: (workspaceId: WorkspaceId) => Promise<WorkspaceId>;
	readonly isRunning: (workspaceId: WorkspaceId) => Promise<boolean>;
	readonly exposeHttp: (
		workspaceId: WorkspaceId,
		port: number,
		hostname: string,
	) => Promise<string>;
	readonly destroyOrphans: (slugPrefix: string) => Promise<readonly string[]>;
	readonly snapshotEnvironment: (
		workspaceId: WorkspaceId,
		slug: string,
	) => Promise<string>;
	readonly provisionSession: (
		slug: string,
		snapshotId: string,
		machineSize?: MachineSizeId,
	) => Promise<WorkspaceId>;
}

export interface CodexRuntime {
	readonly machines: WorkspaceMachines;
	readonly workspaceId: WorkspaceId;
	readonly root: string;
}
