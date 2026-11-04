import { Effect } from "effect";
import type { PtySession } from "freestyle";
import { copiedAgentMachineRef } from "#/domain/agent-session";
import {
	terminalConnectBlockedReason,
	terminalSessionBlockedReason,
} from "#/domain/workspace-terminal";
import { readFreestyleApiKey } from "../adapters/freestyle/api-key";
import {
	openWorkspacePty,
	workspaceVmExec,
} from "../adapters/freestyle/workspace-pty";
import { readyWorkspaceForOwner } from "../adapters/workspaces";
import { peekAgentSessionMachine } from "./agent-session-machine";
import { startTerminalMachineGit } from "./terminal-machine-git";

export async function connectWorkspaceTerminal(input: {
	readonly userId: string;
	readonly projectId: string;
	readonly sessionId?: string;
	readonly directory: string;
	readonly cols: number;
	readonly rows: number;
	readonly onData: (data: Uint8Array) => void;
	readonly onError: (cause: unknown) => void;
}): Promise<{ pty: PtySession; release(): Promise<void> }> {
	// Independent reads: opening the terminal waits on all of them.
	const [workspace, peeked] = await Promise.all([
		readyWorkspaceForOwner(input.userId, input.projectId),
		peekAgentSessionMachine({
			userId: input.userId,
			projectId: input.projectId,
			sessionId: input.sessionId,
		}),
	]);
	const blocked = terminalConnectBlockedReason(workspace, peeked.providerRef);
	if (blocked || !workspace) {
		throw new Error(
			blocked ?? "Prepare a workspace before opening the terminal.",
		);
	}
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
	const pty = await openWorkspacePty({
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
	// Plain git in the terminal works when it is the chat's own machine (not
	// the project template), and only while the terminal stays open. The
	// terminal does not wait for it.
	const chat = peeked.session;
	const git =
		chat &&
		chat.projectId === input.projectId &&
		peeked.providerRef === providerRef
			? startTerminalMachineGit({
					userId: input.userId,
					sessionId: chat.id,
					exec: workspaceVmExec(apiKey, providerRef),
				}).catch(() => null)
			: Promise.resolve(null);
	return { pty, release: async () => (await git)?.stop() };
}
