import type { AuthSnapshotId, WorkspaceId } from "#/domain/ids";
import type { MachineSizeId } from "#/domain/machine-size";
import type { VmEdgeRoute, VmEdgeRouteKind } from "#/domain/vm-edge-routes";
import type { VmNetworkPolicy } from "#/domain/vm-network-policy";

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
	/**
	 * Makes a VM's internet access match the project's policy (firewall grant
	 * and Outbound TLS rules), idempotently. Providers without it stay open.
	 */
	readonly applyNetworkPolicy?: (
		workspaceId: WorkspaceId,
		policy: VmNetworkPolicy,
	) => Promise<void>;
	readonly restoreRetainedSession?: (
		userId: string,
		sessionId: string,
		oldVmId: string,
	) => Promise<string | null>;
	/** Moves the chat's recovery binding from its lost VM to the replacement copy. */
	readonly rebindRetainedSession?: (
		sessionId: string,
		fromVmId: string,
		toVmId: string,
	) => Promise<void>;
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
	/** A file's bytes; like readTextFile, it reads a paused machine's disk without starting it. */
	readonly readFile?: (
		workspaceId: WorkspaceId,
		path: string,
	) => Promise<Uint8Array | null>;
	readonly destroy: (workspaceId: WorkspaceId) => Promise<void>;
	readonly ensureRunning: (workspaceId: WorkspaceId) => Promise<WorkspaceId>;
	readonly isRunning: (workspaceId: WorkspaceId) => Promise<boolean>;
	readonly exposeHttp: (
		workspaceId: WorkspaceId,
		port: number,
		hostname: string,
	) => Promise<string>;
	/** Like exposeHttp, optionally behind a forward-auth check, and replacing superseded routes. */
	readonly publishHttpRoute?: (
		workspaceId: WorkspaceId,
		route: { hostname: string; port: number; forwardAuthId?: string },
	) => Promise<{ origin: string; ruleId: string }>;
	readonly listHttpRoutes?: (
		workspaceId: WorkspaceId,
	) => Promise<readonly VmEdgeRoute[]>;
	/** Deletes this app's routes of these kinds (optionally one port's); returns how many. */
	readonly withdrawHttpRoutes?: (
		workspaceId: WorkspaceId,
		kinds: readonly VmEdgeRouteKind[],
		port?: number,
	) => Promise<number>;
	/** Id of the account's forward-auth config at this URL, created on first use. */
	readonly ensureEdgeAuthorizer?: (config: {
		url: string;
		headers: Record<string, string>;
		protectedCookies: string[];
	}) => Promise<string>;
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
