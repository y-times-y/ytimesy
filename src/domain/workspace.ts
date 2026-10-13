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

/**
 * Freestyle `exec` and `fs.writeTextFile` boot a paused VM. Reads do not.
 * Callers that only need a transcript must not mutate the guest.
 */
export function guestMutationBlockedReason(state: string): string | null {
	if (state === "paused" || state === "stopped") {
		return "Workspace VM is paused.";
	}
	return null;
}
