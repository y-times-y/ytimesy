export const workspaceStatuses = [
	"queued",
	"provisioning",
	"cloning",
	"installing",
	"ready",
	"failed",
] as const;
export type WorkspaceStatus = (typeof workspaceStatuses)[number];

export interface ProjectWorkspace {
	id: string;
	userId: string;
	projectId: string;
	status: WorkspaceStatus;
	providerRef: string | null;
	errorMessage: string | null;
	updatedAt: string;
}

export function workspaceSlug(workspaceId: string) {
	return `ytimesy-ws-${workspaceId}`;
}

export function canStartPrepare(status: WorkspaceStatus | undefined) {
	return status === undefined || status === "queued" || status === "failed";
}

export function workspaceSessionMachineRef(
	workspace: Pick<ProjectWorkspace, "status" | "providerRef"> | null,
) {
	if (workspace?.status === "ready" && workspace.providerRef)
		return workspace.providerRef;
	return null;
}

export function codexConnectBlockedReason(
	workspace: Pick<
		ProjectWorkspace,
		"status" | "providerRef" | "errorMessage"
	> | null,
) {
	if (workspaceSessionMachineRef(workspace)) return null;
	if (!workspace) return "Prepare a workspace before signing in to Codex.";
	if (workspace.status === "failed")
		return (
			workspace.errorMessage ??
			"Workspace preparation failed. Retry, then sign in to Codex."
		);
	return "Wait for workspace preparation to finish before signing in to Codex.";
}

export function branchSwitchBlockedReason(
	status: WorkspaceStatus | undefined,
): string | null {
	if (
		status === "provisioning" ||
		status === "cloning" ||
		status === "installing"
	)
		return "Wait for workspace preparation to finish.";
	return null;
}

export function blocksDuplicateProvision(status: WorkspaceStatus) {
	return (
		status === "ready" ||
		status === "provisioning" ||
		status === "cloning" ||
		status === "installing"
	);
}

export function needsMachineCreate(
	status: WorkspaceStatus,
	providerRef: string | null,
) {
	return status === "provisioning" && providerRef === null;
}

export function needsMachineRecover(
	status: WorkspaceStatus,
	providerRef: string | null,
) {
	return (
		providerRef !== null &&
		(status === "provisioning" ||
			status === "cloning" ||
			status === "installing")
	);
}

export function publicFailureMessage(error: unknown) {
	const message =
		error instanceof Error
			? error.message
			: error instanceof Response
				? error.statusText
				: "Workspace preparation failed. Retry after checking GitHub access.";
	return redactSecrets(message).slice(0, 300);
}

export function redactSecrets(value: string) {
	return value
		.replace(/ghp_[A-Za-z0-9]+/g, "[redacted]")
		.replace(/github_pat_[A-Za-z0-9_]+/g, "[redacted]")
		.replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
		.replace(
			/AUTHORIZATION:\s*bearer\s+\S+/gi,
			"AUTHORIZATION: bearer [redacted]",
		);
}
