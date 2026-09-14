import type { WorkspaceId } from "./ids";

export type WorkspaceLifecycle =
	| { readonly status: "creating" }
	| { readonly status: "running"; readonly workspaceId: WorkspaceId }
	| { readonly status: "paused"; readonly workspaceId: WorkspaceId }
	| { readonly status: "failed"; readonly reason: string }
	| { readonly status: "deleted" };

export function isUsableWorkspace(workspace: WorkspaceLifecycle): workspace is {
	readonly status: "running";
	readonly workspaceId: WorkspaceId;
} {
	return workspace.status === "running";
}

export function workspaceProviderId(
	workspace: WorkspaceLifecycle,
): WorkspaceId | undefined {
	if (workspace.status === "running" || workspace.status === "paused") {
		return workspace.workspaceId;
	}
	return undefined;
}
