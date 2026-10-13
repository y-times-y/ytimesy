import { readFileSync } from "node:fs";
import type { ModelMessage } from "ai";
import type { WorkspaceId } from "#/domain/ids";
import { posixShellQuoted } from "#/domain/posix-command";
import type { WorkspaceMachines } from "./workspace-machines";

export const PEER_INBOX_PATH = "/tmp/ytimesy-peer-inbox";
export const PEER_INBOX_SOURCE = readFileSync(
	new URL("../adapters/peer-inbox.py", import.meta.url),
	"utf8",
);

function messagePath(id: string) {
	if (!/^[a-zA-Z0-9-]+$/.test(id)) throw new Error("Invalid peer message ID.");
	return `${PEER_INBOX_PATH}/${id}.json`;
}

export async function peerMessageAccepted(
	machines: WorkspaceMachines,
	workspaceId: WorkspaceId,
	id: string,
) {
	return (
		(
			await machines.readTextFile(workspaceId, `${messagePath(id)}.accepted`)
		)?.trim() === "accepted"
	);
}

/** pg-boss retains the job until the runtime acknowledges this individual message. */
export async function stagePeerMessage(
	machines: WorkspaceMachines,
	workspaceId: WorkspaceId,
	id: string,
	text: string,
	recipientId: string,
) {
	const path = messagePath(id);
	const content = JSON.stringify({ id, text, recipientId });
	const result = await machines.exec(
		workspaceId,
		`mkdir -p ${PEER_INBOX_PATH}\nif [ ! -f ${path} ]; then printf '%s' ${posixShellQuoted(content)} >${path}.tmp; mv ${path}.tmp ${path}; fi`,
		10_000,
	);
	if (result.exitCode !== 0) throw new Error("Peer mailbox is unavailable.");
}

/** Checkpoint injected history before acknowledging; worker retries cannot silently lose it. */
export async function injectApiPeerMessages(
	machines: WorkspaceMachines,
	workspaceId: WorkspaceId,
	history: ModelMessage[],
	checkpoint: (messages: ModelMessage[]) => Promise<void>,
	recipientId: string,
): Promise<ModelMessage[]> {
	const command = `python3 -c ${posixShellQuoted(PEER_INBOX_SOURCE)} ${PEER_INBOX_PATH}`;
	const result = await machines.exec(
		workspaceId,
		`${command} peek ${posixShellQuoted(recipientId)}`,
		10_000,
	);
	if (result.exitCode !== 0) throw new Error("Peer mailbox could not be read.");
	const pending = JSON.parse(result.stdout) as { id: string; text: string }[];
	if (!pending.length) return history;
	for (const message of pending) messagePath(message.id);
	const injected: ModelMessage[] = [...history];
	for (const message of pending) {
		if (
			!injected.some(
				(item) => item.role === "user" && item.content === message.text,
			)
		)
			injected.push({ role: "user", content: message.text });
	}
	await checkpoint(injected);
	const receipt = await machines.exec(
		workspaceId,
		`${command} ack ${pending.map((message) => posixShellQuoted(message.id)).join(" ")}`,
		10_000,
	);
	if (receipt.exitCode !== 0)
		throw new Error("Peer mailbox acknowledgement failed.");
	return injected;
}
