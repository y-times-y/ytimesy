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
	readonly runCapability?: (
		workspaceId: WorkspaceId,
		request: {
			capability: "language" | "debugger" | "browser";
			source: string;
			arguments: unknown;
			onlyInstalled?: boolean;
		},
		signal: AbortSignal,
	) => Promise<CommandOutput>;
	readonly restoreRetainedSession?: (
		userId: string,
		sessionId: string,
		oldVmId: string,
	) => Promise<string | null>;
	readonly createProofWorkspace: (
		options?: CreateProofWorkspaceOptions,
	) => Promise<ProofWorkspace>;
	/** Retired with the VM logins; kept optional only for the evaluation harness's machine fake. */
	readonly snapshotAuthenticatedWorkspace?: () => Promise<unknown>;
	/** Deletes a VM snapshot (evaluations remove their environment snapshots with this). */
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
	/**
	 * Forks a running VM (memory and disk) into a new VM with this slug, for
	 * a writer subagent; secrets are kept (fork-vm.ts). Providers without
	 * live snapshots leave it out and writers are refused.
	 */
	readonly forkWorkspace?: (
		source: WorkspaceId,
		slug: string,
		machineSize?: MachineSizeId,
	) => Promise<{ vm: WorkspaceId; forkMs: number }>;
}
