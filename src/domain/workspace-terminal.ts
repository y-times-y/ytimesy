import {
	type ProjectWorkspace,
	workspaceSessionMachineRef,
} from "./project-workspace";

export const WORKSPACE_PTY_SLUG = "main";

export type TerminalClientControl = {
	readonly type: "resize";
	readonly cols: number;
	readonly rows: number;
};

export function isWorkspacePtySlug(value: string) {
	return /^[a-z](?:[a-z0-9-]*[a-z0-9])?$/.test(value) && !/^\d+$/.test(value);
}

export function clampPtySize(cols: number, rows: number) {
	return {
		cols: Math.min(300, Math.max(20, Math.floor(cols) || 80)),
		rows: Math.min(100, Math.max(8, Math.floor(rows) || 24)),
	};
}

export function parseTerminalClientMessage(
	value: string,
): TerminalClientControl | null {
	try {
		const parsed = JSON.parse(value) as { type?: unknown };
		if (parsed.type !== "resize") return null;
		const cols = Number((parsed as { cols?: unknown }).cols);
		const rows = Number((parsed as { rows?: unknown }).rows);
		if (!Number.isFinite(cols) || !Number.isFinite(rows)) return null;
		return { type: "resize", ...clampPtySize(cols, rows) };
	} catch {
		return null;
	}
}

export function terminalConnectBlockedReason(
	workspace:
		| (Pick<ProjectWorkspace, "status" | "providerRef"> & {
				errorMessage?: string | null;
		  })
		| null,
) {
	if (workspaceSessionMachineRef(workspace)) return null;
	if (!workspace) return "Prepare a workspace before opening the terminal.";
	if (workspace.status === "failed")
		return (
			workspace.errorMessage ??
			"Workspace preparation failed. Retry, then open the terminal."
		);
	return "Wait for workspace preparation to finish before opening the terminal.";
}

export function terminalSessionBlockedReason(
	sessionProviderRef: string | null,
) {
	if (sessionProviderRef) return null;
	return "Connect an agent before opening the terminal.";
}

export function workspacePtyCommand(directory: string) {
	return `cd ${shellSingleQuote(directory)} && exec bash -l`;
}

function shellSingleQuote(value: string) {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}
