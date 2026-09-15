import {
	isWorkspaceAtCapacity,
	isWorkspaceComputeAllowanceExhausted,
} from "./failure-message";

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
	templateSnapshotId: string | null;
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

export function harnessConnectBlockedReason(
	workspace: Pick<
		ProjectWorkspace,
		"status" | "providerRef" | "errorMessage"
	> | null,
	harnessName: string,
	kind: "sign_in" | "connect" = "sign_in",
) {
	const action =
		kind === "connect"
			? `connecting ${harnessName}`
			: `signing in to ${harnessName}`;
	if (workspaceSessionMachineRef(workspace)) return null;
	if (!workspace) return `Prepare a workspace before ${action}.`;
	if (workspace.status === "failed")
		return (
			workspace.errorMessage ??
			`Workspace preparation failed. Retry, then finish ${action}.`
		);
	return `Wait for workspace preparation to finish before ${action}.`;
}

export function codexConnectBlockedReason(
	workspace: Pick<
		ProjectWorkspace,
		"status" | "providerRef" | "errorMessage"
	> | null,
) {
	return harnessConnectBlockedReason(workspace, "Codex");
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
	return workspaceCapacityMessage(redactSecrets(message).slice(0, 300));
}

export function workspaceCapacityMessage(message: string) {
	if (isWorkspaceAtCapacity(message)) {
		return "This Freestyle plan is at its VM limit. Delete an unused agent session or raise the quota before starting another. Pausing a VM does not free a slot.";
	}
	if (isWorkspaceComputeAllowanceExhausted(message)) {
		return "This Freestyle plan has used its compute allowance. Wait for the allowance to reset or upgrade the plan, then resume the VM.";
	}
	return message;
}

export function redactSecrets(value: string) {
	return value
		.replace(/ghp_[A-Za-z0-9]+/g, "[redacted]")
		.replace(/github_pat_[A-Za-z0-9_]+/g, "[redacted]")
		.replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
		.replace(
			/AUTHORIZATION:\s*bearer\s+\S+/gi,
			"AUTHORIZATION: bearer [redacted]",
		)
		.replace(
			/AUTHORIZATION:\s*basic\s+\S+/gi,
			"AUTHORIZATION: basic [redacted]",
		)
		.replace(/x-access-token:[^@\s]+@/g, "x-access-token:***@");
}
