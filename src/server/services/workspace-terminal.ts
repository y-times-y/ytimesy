import { Effect } from "effect";
import type { PtySession } from "freestyle";
import { copiedAgentMachineRef } from "#/domain/agent-session";
import {
	terminalConnectBlockedReason,
	terminalSessionBlockedReason,
} from "#/domain/workspace-terminal";
import { readFreestyleApiKey } from "../adapters/freestyle/api-key";
import { openWorkspacePty } from "../adapters/freestyle/workspace-pty";
import { readyWorkspaceForOwner } from "../adapters/workspaces";
import { peekAgentSessionMachine } from "./agent-session-machine";

export async function connectWorkspaceTerminal(input: {
	readonly userId: string;
	readonly projectId: string;
	readonly sessionId?: string;
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
	const peeked = await peekAgentSessionMachine({
		userId: input.userId,
		projectId: input.projectId,
		sessionId: input.sessionId,
	});
	const providerRef = copiedAgentMachineRef({
		sessionProviderRef: peeked.providerRef,
		templateProviderRef: workspace.providerRef,
	});
	const sessionBlocked = terminalSessionBlockedReason(providerRef);
	if (sessionBlocked || !providerRef) {
		throw new Error(
			sessionBlocked ?? "Connect an agent before opening the terminal.",
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
		providerRef,
		directory: input.directory,
		cols: input.cols,
		rows: input.rows,
		events: {
			onData: input.onData,
			onError: input.onError,
		},
	});
}
