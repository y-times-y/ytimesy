import type { AgentTaskToolResponse } from "#/domain/agent-task-tool";

/**
 * Where a chat's tool-call receipts (agent-task-command-receipts.ts) are kept
 * when that chat's turn runs on a box: the edge, through the turn's port
 * (docs/turn-runner-boxes.md, "Tool receipts on a box"). The box registers
 * its running turn's chat here; the adapter's functions ask this first, so
 * every tool that journals its calls (bash, write, edit, run_code, the
 * completion checks) works on a box unchanged. No database is imported here.
 */
export type RemoteCommandReceipts = {
	claim(
		requestId: string,
	): Promise<
		| { readonly kind: "claimed" }
		| { readonly kind: "processing" }
		| { readonly kind: "done"; readonly response: AgentTaskToolResponse }
	>;
	complete(response: AgentTaskToolResponse): Promise<void>;
	renew(requestId: string): Promise<void>;
	retained(requestIds: readonly string[]): Promise<Map<string, unknown>>;
};

const remote = new Map<string, RemoteCommandReceipts>();

/** Registers a chat's receipts as remote; the returned function removes them. */
export function registerRemoteCommandReceipts(
	sessionId: string,
	receipts: RemoteCommandReceipts,
) {
	remote.set(sessionId, receipts);
	return () => {
		if (remote.get(sessionId) === receipts) remote.delete(sessionId);
	};
}

export function remoteCommandReceipts(sessionId: string) {
	return remote.get(sessionId);
}
