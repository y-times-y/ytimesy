import { Effect } from "effect";
import type { PtySession } from "freestyle";
import { terminalConnectBlockedReason } from "#/domain/workspace-terminal";
import { readFreestyleApiKey } from "../adapters/freestyle/api-key";
import { openWorkspacePty } from "../adapters/freestyle/workspace-pty";
import { readyWorkspaceForOwner } from "../adapters/workspaces";

export async function connectWorkspaceTerminal(input: {
	readonly userId: string;
	readonly projectId: string;
	readonly directory: string;
	readonly cols: number;
	readonly rows: number;
	readonly onData: (data: Uint8Array) => void;
	readonly onError: (cause: unknown) => void;
}): Promise<PtySession> {
	const workspace = await readyWorkspaceForOwner(input.userId, input.projectId);
	const blocked = terminalConnectBlockedReason(workspace);
	if (blocked || !workspace?.providerRef) {
		throw new Error(
			blocked ?? "Prepare a workspace before opening the terminal.",
		);
	}
	const apiKey = await Effect.runPromise(
		readFreestyleApiKey().pipe(
			Effect.mapError(
				() =>
					new Error(
						"Workspace hosting is not connected. Retry after the workspace host is available.",
					),
			),
		),
	);
	return openWorkspacePty({
		apiKey,
		providerRef: workspace.providerRef,
		directory: input.directory,
		cols: input.cols,
		rows: input.rows,
		events: {
			onData: input.onData,
			onError: input.onError,
		},
	});
}
